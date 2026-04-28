'use strict';

const http  = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = 9159;

// ── Pure-JS SHA256 (no external deps) ─────────────────────────
function sha256(ascii) {
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    var mp = Math.pow, mw = mp(2, 32), i, j, result = '',
        words = [], abl = ascii.length * 8, hash = [], k = [], pc = 0, ic = {};
    for (var c = 2; pc < 64; c++) {
        if (!ic[c]) {
            for (i = 0; i < 313; i += c) ic[i] = c;
            hash[pc] = (mp(c, .5) * mw) | 0;
            k[pc++]  = (mp(c, 1/3) * mw) | 0;
        }
    }
    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    for (i = 0; i < ascii.length; i++) {
        j = ascii.charCodeAt(i);
        if (j >> 8) return '';
        words[i >> 2] |= j << ((3 - i % 4) * 8);
    }
    words[words.length] = ((abl / mw) | 0);
    words[words.length] = abl;
    for (j = 0; j < words.length;) {
        var w = words.slice(j, j += 16), oh = hash;
        hash = hash.slice(0, 8);
        for (i = 0; i < 64; i++) {
            var w15 = w[i-15], w2 = w[i-2], a = hash[0], e = hash[4];
            var t1 = hash[7]
                + (rr(e,6) ^ rr(e,11) ^ rr(e,25))
                + ((e & hash[5]) ^ (~e & hash[6])) + k[i]
                + (w[i] = (i < 16) ? w[i] : (
                    w[i-16]
                    + (rr(w15,7) ^ rr(w15,18) ^ (w15 >>> 3))
                    + w[i-7]
                    + (rr(w2,17) ^ rr(w2,19) ^ (w2 >>> 10))
                ) | 0);
            var t2 = (rr(a,2) ^ rr(a,13) ^ rr(a,22))
                + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
            hash = [(t1 + t2) | 0].concat(hash);
            hash[4] = (hash[4] + t1) | 0;
            hash.length = 8;
        }
        hash = hash.map(function(h, i) { return (h + oh[i]) | 0; });
    }
    hash.forEach(function(h) {
        for (i = 7; i >= 0; i--) result += ((h >>> (i * 4)) & 0xF).toString(16);
    });
    return result;
}

// ── Transform: meta_data + body → CSV body + signature ────────
function transformRequest(metaData, reqBody) {
    const params = [metaData.trans_type, ...Object.values(reqBody).map(v => String(v == null ? '' : v))];
    const encoded = params.map(t => encodeURIComponent(t));
    const copy    = [...encoded, 'paysys@123'];
    const method  = (metaData.method || 'POST').toUpperCase();

    if (method === 'POST') {
        return {
            method:    'POST',
            csvBody:   encoded.join(','),
            signature: sha256(copy.join(',')),
        };
    } else {
        return {
            method:    'GET',
            csvBody:   null,
            signature: encodeURIComponent(encoded.join(',')) + '/' + sha256(copy.join(',')),
        };
    }
}


function makeRequest(options, bodyBuf) {
    return new Promise((resolve, reject) => {
        const lib = options.protocol === 'https:' ? https : http;
        const req = lib.request({
            ...options,
            rejectUnauthorized: false   // ← ADD THIS LINE
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({
                status:     res.statusCode,
                statusText: res.statusMessage || '',
                headers:    res.headers,
                body:       Buffer.concat(chunks),
            }));
            res.on('error', reject);
        });
        req.setTimeout(30000, () => req.destroy(new Error('Request timed out')));
        req.on('error', reject);
        if (bodyBuf && bodyBuf.length) req.write(bodyBuf);
        req.end();
    });
}
// ── HTTP helper ────────────────────────────────────────────────
// ── Main server ────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // Read body for all POST requests
    const raw = [];
    req.on('data', c => raw.push(c));
    await new Promise(r => req.on('end', r));
    const rawBody = Buffer.concat(raw);

    const url = req.url.split('?')[0].replace(/\/$/, '') || '/';

    // ── /forward — transform + forward to Spring service ──────
    // Accepts: { "target_url": "...", "meta_data": {...}, "body": {...} }
    // Transforms to CSV body + SHA256 signature, forwards to target_url/{sig}
    if (url === '/forward') {
        let payload;
        try {
            payload = JSON.parse(rawBody.toString());
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }

        const { target_url, meta_data, body: reqBody } = payload;

        if (!target_url || !meta_data || !reqBody) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Required: target_url, meta_data, body' }));
        }

        let transformed;
        try {
            transformed = transformRequest(meta_data, reqBody);
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Transform failed: ' + e.message }));
        }

        const forwardUrl = target_url.replace(/\/$/, '') + '/' + transformed.signature;
        console.log(`[forward] ${transformed.method} ${forwardUrl}`);
        console.log(`[forward] body: ${transformed.csvBody}`);

        try {
            const target  = new URL(forwardUrl);
            const bodyBuf = transformed.csvBody ? Buffer.from(transformed.csvBody) : Buffer.alloc(0);

            const result = await makeRequest({
                protocol: target.protocol,
                hostname: target.hostname,
                port:     target.port || (target.protocol === 'https:' ? 443 : 80),
                path:     target.pathname + target.search,
                method:   transformed.method,
                headers: {
                    'content-type':   'text/plain',
                    'content-length': String(bodyBuf.length),
                },
            }, bodyBuf);

            res.writeHead(result.status, {
                'Content-Type': result.headers['content-type'] || 'application/json',
            });
            res.end(result.body);
        } catch (err) {
            console.error('[forward] Error:', err.message);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // ── /proxy/ — Hoppscotch CORS proxy protocol ──────────────
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, data: { message: 'Only POST accepted' } }));
    }

    let payload;
    try {
        payload = JSON.parse(rawBody.toString());
    } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, data: { message: 'Invalid JSON' } }));
    }

    const reqData = (payload.v === '1' && payload.data) ? payload.data : payload;
    const {
        method:      fwdMethod    = 'GET',
        url:         fwdUrl       = '',
        headers:     fwdHeaders   = {},
        body:        fwdBody      = null,
        wantsBinary               = false,
    } = reqData;

    if (!fwdUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, data: { message: 'Missing url' } }));
    }

    console.log(`[proxy] ${fwdMethod} ${fwdUrl}`);

    try {
        const target  = new URL(fwdUrl);
        const bodyBuf = fwdBody ? Buffer.from(fwdBody) : Buffer.alloc(0);
        const headers = { ...fwdHeaders };

        if (bodyBuf.length && !headers['content-length'] && !headers['Content-Length']) {
            headers['content-length'] = String(bodyBuf.length);
        }

        const result = await makeRequest({
            protocol: target.protocol,
            hostname: target.hostname,
            port:     target.port || (target.protocol === 'https:' ? 443 : 80),
            path:     target.pathname + target.search,
            method:   fwdMethod.toUpperCase(),
            headers,
        }, bodyBuf);

        const responseData = wantsBinary
            ? result.body.toString('base64')
            : result.body.toString('utf8');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success:    true,
            isBinary:   wantsBinary,
            status:     result.status,
            statusText: result.statusText,
            headers:    result.headers,
            data:       responseData,
        }));
    } catch (err) {
        console.error(`[proxy] Error: ${err.message}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            data:    { name: err.name || 'Error', message: err.message },
        }));
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[hopps-proxy] Listening on port ${PORT}`);
    console.log(`[hopps-proxy] /forward  → transform + forward to Spring`);
    console.log(`[hopps-proxy] /proxy/   → CORS proxy for Hoppscotch`);
});
