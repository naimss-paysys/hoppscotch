'use strict';

const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const { Pool }        = require('pg');
const crypto          = require('crypto');
const http            = require('http');
const https           = require('https');

// ── Config ────────────────────────────────────────────────────
const EMAIL_API_URL        = process.env.EMAIL_API_URL        || 'http://10.0.150.16:7034/api/EmailService';
const FROM_NAME            = process.env.FROM_NAME            || 'paysyslabs';
const FROM_EMAIL           = process.env.FROM_EMAIL           || 'watcher@paysyslabs.com';
const PUBLIC_URL           = process.env.PUBLIC_URL           || 'http://api.paysyslabs.com:8090';
const ADMIN_URL            = process.env.ADMIN_URL            || 'http://api.paysyslabs.com:8091';
const BACKEND_URL          = process.env.BACKEND_URL          || 'http://hoppscotch-backend:8080';
const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID     || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_CALLBACK_URL  = process.env.GITHUB_CALLBACK_URL  || `${PUBLIC_URL}/api/auth/github/callback`;

// ── PostgreSQL ────────────────────────────────────────────────
const db = new Pool({
    host:     process.env.DB_HOST     || 'postgres-hopps',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'hoppscotch',
    user:     process.env.DB_USER     || 'hoppscotch',
    password: process.env.DB_PASSWORD || 'REDACTED_DB_PASS',
    max: 3,
});

async function getExistingDeviceHash(token) {
    try {
        const { rows } = await db.query(
            'SELECT "deviceIdentifier" FROM "VerificationToken" WHERE token = $1 LIMIT 1',
            [token]
        );
        return rows[0]?.deviceIdentifier || null;
    } catch (e) {
        console.error('[smtp-bridge] DB query failed:', e.message);
        return null;
    }
}

async function getTokenByHash(deviceIdentifierHash) {
    try {
        const { rows } = await db.query(
            'SELECT token FROM "VerificationToken" WHERE "deviceIdentifier" = $1 LIMIT 1',
            [deviceIdentifierHash]
        );
        return rows[0]?.token || null;
    } catch (e) {
        console.error('[smtp-bridge] Token query failed:', e.message);
        return null;
    }
}

async function isAdminUser(email) {
    try {
        const { rows } = await db.query(
            'SELECT "isAdmin" FROM "User" WHERE email = $1 LIMIT 1',
            [email]
        );
        return rows[0]?.isAdmin === true;
    } catch (e) {
        console.error('[smtp-bridge] isAdmin query failed:', e.message);
        return false;
    }
}

async function getInviteInfo(inviteId) {
    try {
        const { rows } = await db.query(
            `SELECT t.name AS team_name, ti."inviteeEmail"
             FROM "TeamInvitation" ti
             JOIN "Team" t ON ti."teamID" = t.id
             WHERE ti.id = $1`,
            [inviteId]
        );
        return rows[0] || null;
    } catch (e) {
        console.error('[smtp-bridge] Invite query failed:', e.message);
        return null;
    }
}

// ── 3DES Encryption ───────────────────────────────────────────
const md5Digest = crypto.createHash('md5')
    .update(Buffer.from('bW9uZXRAMTIz', 'base64'))
    .digest();
const keyBytes = Buffer.alloc(24);
md5Digest.copy(keyBytes, 0, 0, 16);
for (let j = 0, k = 16; j < 8; j++, k++) keyBytes[k] = md5Digest[j];
const desIv = Buffer.from('paysys12', 'utf8');

function encrypt(plaintext) {
    const cipher = crypto.createCipheriv('des-ede3-cbc', keyBytes, desIv);
    const enc = Buffer.concat([cipher.update(plaintext || '', 'utf8'), cipher.final()]);
    return Buffer.from(enc.toString('base64'), 'utf8').toString('base64');
}

function stanGenerator() {
    return Date.now().toString() + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
}

// ── PaysysLabs email API ──────────────────────────────────────
function callEmailApi(toName, toEmail, subject, body) {
    return new Promise((resolve, reject) => {
        const segments = [
            encrypt(stanGenerator()),
            encrypt(toName || toEmail),
            encrypt(toEmail),
            encrypt(FROM_NAME),
            encrypt(FROM_EMAIL),
            encrypt(body),
            encrypt(subject || 'Hoppscotch'),
        ];
        const url = EMAIL_API_URL + '/' + segments.join('/');
        console.log(`[smtp-bridge] → ${toEmail} | ${subject}`);
        http.get(url, (res) => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => { console.log(`[smtp-bridge] API ${res.statusCode}`); resolve(d); });
        }).on('error', reject);
    });
}

// ── URL extraction ────────────────────────────────────────────
function extractMagicUrl(text, html) {
    const src = text || html || '';
    const m = src.match(/https?:\/\/[^\s<>"]+\/enter\?token=[^\s<>"\]&]+/);
    return m ? m[0].trim() : null;
}
function extractToken(url) {
    const m = url.match(/[?&]token=([^&\s]+)/);
    return m ? m[1] : null;
}
function extractJoinTeamUrl(text, html) {
    const src = text || html || '';
    const m = src.match(/https?:\/\/[^\s<>"]+\/join-team\?id=[^\s<>"\]&]+/);
    return m ? m[0].trim() : null;
}
function extractJoinTeamId(url) {
    const m = url.match(/[?&]id=([^&\s]+)/);
    return m ? m[1] : null;
}

// ── Backend calls ─────────────────────────────────────────────
function callBackendSignin(email) {
    return new Promise((resolve, reject) => {
        const deviceIdentifier = 'bridge-' + crypto.randomBytes(16).toString('hex');
        const body = JSON.stringify({ email, deviceIdentifier });
        const backendHost = BACKEND_URL.replace(/^https?:\/\//, '').split(':')[0];
        const backendPort = parseInt((BACKEND_URL.split(':')[2]) || '8080');
        const req = http.request({
            hostname: backendHost, port: backendPort,
            path: '/v1/auth/signin', method: 'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function callBackendVerify(token, deviceIdentifier) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ token, deviceIdentifier });
        const backendHost = BACKEND_URL.replace(/^https?:\/\//, '').split(':')[0];
        const backendPort = parseInt((BACKEND_URL.split(':')[2]) || '8080');
        const req = http.request({
            hostname: backendHost, port: backendPort,
            path: '/v1/auth/verify', method: 'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── GitHub OAuth (custom — bypasses passport-github2) ────────
// passport-github2 only picks the primary email; if the account has
// no primary flagged, profile.emails stays undefined → 401.
// We handle the full flow here and pick ANY valid email GitHub returns.

const githubStateMap = new Map(); // state → timestamp

function cleanupStates() {
    const cut = Date.now() - 10 * 60 * 1000;
    for (const [s, ts] of githubStateMap) { if (ts < cut) githubStateMap.delete(s); }
}

function httpsPost(hostname, path, body, extraHeaders) {
    return new Promise((resolve, reject) => {
        const buf = Buffer.from(body);
        const req = https.request({
            hostname, path, method: 'POST',
            headers: {
                'Content-Type':   'application/x-www-form-urlencoded',
                'Accept':         'application/json',
                'User-Agent':     'PaysysLabs-Hoppscotch/1.0',
                'Content-Length': buf.length,
                ...extraHeaders,
            },
        }, (res) => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
        });
        req.on('error', reject);
        req.write(buf);
        req.end();
    });
}

function httpsGet(hostname, path, extraHeaders) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname, path, method: 'GET',
            headers: {
                'Accept':     'application/vnd.github+json',
                'User-Agent': 'PaysysLabs-Hoppscotch/1.0',
                ...extraHeaders,
            },
        }, (res) => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function exchangeGithubCode(code) {
    const body = new URLSearchParams({
        client_id:     GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri:  GITHUB_CALLBACK_URL,
    }).toString();
    const r = await httpsPost('github.com', '/login/oauth/access_token', body);
    const json = JSON.parse(r.body);
    if (json.error) throw new Error(`GitHub token: ${json.error_description || json.error}`);
    return json.access_token;
}

async function getGithubEmails(accessToken) {
    const r = await httpsGet('api.github.com', '/user/emails', {
        'Authorization':        `Bearer ${accessToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
    });
    if (r.status !== 200) throw new Error(`GitHub emails API: HTTP ${r.status}`);
    return JSON.parse(r.body);
}

// Served after GitHub OAuth for users who are also admins.
// Cookies are set in the response headers — both buttons work immediately.
function buildChoosePortalHtml(adminUrl, userUrl) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>PaysysLabs — Choose Portal</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#f0f2f5;font-family:Arial,Helvetica,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);width:480px;max-width:95vw}
    .header{background:#1a1a2e;padding:28px 36px}
    .header h1{color:#fff;font-size:22px;font-weight:700}
    .header p{color:#e8a000;font-size:12px;margin-top:4px}
    .body{padding:36px}
    .body h2{font-size:18px;color:#1a1a2e;margin-bottom:8px}
    .body .sub{font-size:14px;color:#555;margin-bottom:28px;line-height:1.6}
    .btn{display:block;width:100%;padding:14px 24px;border-radius:8px;font-size:15px;font-weight:600;color:#fff;text-decoration:none;text-align:center;margin-bottom:12px}
    .btn-admin{background:#e8a000}
    .btn-user{background:#3b5bdb}
    .note{font-size:12px;color:#aaa;margin-top:8px;text-align:center}
    .footer{background:#f8f9fa;padding:16px 36px;border-top:1px solid #eee;font-size:11px;color:#aaa}
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>PaysysLabs</h1>
      <p>&#9654; You are signed in &mdash; choose where to go</p>
    </div>
    <div class="body">
      <h2>GitHub sign-in successful</h2>
      <p class="sub">You have both <strong>admin</strong> and <strong>user</strong> access.<br>Pick a portal to open.</p>
      <a href="${adminUrl}" class="btn btn-admin">&#9654; Open Admin Panel</a>
      <a href="${userUrl}" class="btn btn-user">Open Hoppscotch App &rarr;</a>
      <p class="note">You can switch portals any time by signing in again.</p>
    </div>
    <div class="footer">&copy; ${new Date().getFullYear()} PaysysLabs &mdash; watcher@paysyslabs.com</div>
  </div>
</body>
</html>`;
}

// Priority: primary+verified > primary > any verified > noreply alias > first
function pickBestEmail(emails) {
    if (!Array.isArray(emails) || !emails.length) return null;
    return (
        emails.find(e => e.primary && e.verified)?.email ||
        emails.find(e => e.primary)?.email ||
        emails.find(e => e.verified)?.email ||
        emails.find(e => e.email?.includes('noreply.github.com'))?.email ||
        emails[0]?.email ||
        null
    );
}

// ── Cookie rewriting ──────────────────────────────────────────
function rewriteCookie(cookieStr) {
    return cookieStr
        .replace(/;\s*Secure/gi,                       '')
        .replace(/;\s*SameSite=(None|Strict)/gi,       '; SameSite=Lax')
        .replace(/;\s*Path=\/v1\/auth\/refresh/gi,     '; Path=/api/auth/refresh')
        .replace(/;\s*Path=\/v1\//gi,                  '; Path=/')
        .replace(/;\s*Domain=hoppscotch-[^\s;,]*/gi,  '');
}

// ── Email HTML templates ──────────────────────────────────────
function buildSignInHtml(toName, clickUrl) {
    const name = toName && toName !== 'undefined' ? toName : 'there';
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0">
  <tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
      <tr><td style="background:#1a1a2e;padding:28px 40px">
        <p style="margin:0;font-size:22px;font-weight:700;color:#fff">PaysysLabs</p>
        <p style="margin:4px 0 0;font-size:12px;color:#8888aa">Internal Developer Platform</p>
      </td></tr>
      <tr><td style="padding:36px 40px 28px">
        <p style="margin:0 0 8px;font-size:18px;font-weight:600;color:#1a1a2e">Sign in to Hoppscotch</p>
        <p style="margin:0 0 24px;font-size:14px;color:#555">Hello ${name},</p>
        <p style="margin:0 0 28px;font-size:14px;color:#555;line-height:1.6">
          Click the button below to sign in. Works from any browser or device.
          Valid for <strong>24 hours</strong>, single-use.
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 28px">
          <tr><td style="background:#3b5bdb;border-radius:7px">
            <a href="${clickUrl}" style="display:inline-block;padding:13px 32px;font-size:15px;font-weight:600;color:#fff;text-decoration:none">
              Sign in to Hoppscotch &rarr;
            </a>
          </td></tr>
        </table>
        <p style="margin:0 0 6px;font-size:12px;color:#888">Or copy this URL:</p>
        <p style="margin:0;font-size:11px;color:#3b5bdb;word-break:break-all">${clickUrl}</p>
      </td></tr>
      <tr><td style="background:#f8f9fa;padding:20px 40px;border-top:1px solid #eee">
        <p style="margin:0;font-size:11px;color:#aaa">
          Ignore if you didn't request this.<br>
          &copy; ${new Date().getFullYear()} PaysysLabs &mdash; watcher@paysyslabs.com
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function buildAdminSignInHtml(toName, adminUrl, userUrl) {
    const name = toName && toName !== 'undefined' ? toName : 'there';
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0">
  <tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
      <tr><td style="background:#1a1a2e;padding:28px 40px">
        <p style="margin:0;font-size:22px;font-weight:700;color:#fff">PaysysLabs</p>
        <p style="margin:4px 0 0;font-size:12px;color:#e8a000">&#9654; Admin &amp; User Access</p>
      </td></tr>
      <tr><td style="padding:36px 40px 28px">
        <p style="margin:0 0 8px;font-size:18px;font-weight:600;color:#1a1a2e">Sign In — Choose Where to Go</p>
        <p style="margin:0 0 24px;font-size:14px;color:#555">Hello ${name},</p>
        <p style="margin:0 0 24px;font-size:14px;color:#555;line-height:1.6">
          You have both <strong>admin</strong> and <strong>user</strong> access.<br>
          Click one button below. The link is <strong>single-use</strong> — only the first click works.
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 16px">
          <tr><td style="background:#e8a000;border-radius:7px">
            <a href="${adminUrl}" style="display:inline-block;padding:13px 32px;font-size:15px;font-weight:600;color:#fff;text-decoration:none">
              &#9654; Open Admin Portal
            </a>
          </td></tr>
        </table>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 28px">
          <tr><td style="background:#3b5bdb;border-radius:7px">
            <a href="${userUrl}" style="display:inline-block;padding:13px 32px;font-size:15px;font-weight:600;color:#fff;text-decoration:none">
              Open Hoppscotch App &rarr;
            </a>
          </td></tr>
        </table>
        <p style="margin:0;font-size:12px;color:#aaa">Valid for 24 hours &mdash; single-use. Sign in again to switch portals.</p>
      </td></tr>
      <tr><td style="background:#f8f9fa;padding:20px 40px;border-top:1px solid #eee">
        <p style="margin:0;font-size:11px;color:#aaa">
          If you did not request this, ignore the email immediately.<br>
          &copy; ${new Date().getFullYear()} PaysysLabs &mdash; watcher@paysyslabs.com
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function buildInviteHtml(toName, teamName, acceptUrl) {
    const name = toName && toName !== 'undefined' ? toName : 'there';
    const team = teamName || 'a workspace';
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0">
  <tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
      <tr><td style="background:#1a1a2e;padding:28px 40px">
        <p style="margin:0;font-size:22px;font-weight:700;color:#fff">PaysysLabs</p>
        <p style="margin:4px 0 0;font-size:12px;color:#8888aa">Internal Developer Platform</p>
      </td></tr>
      <tr><td style="padding:36px 40px 28px">
        <p style="margin:0 0 8px;font-size:18px;font-weight:600;color:#1a1a2e">You've been invited to a workspace</p>
        <p style="margin:0 0 24px;font-size:14px;color:#555">Hello ${name},</p>
        <p style="margin:0 0 28px;font-size:14px;color:#555;line-height:1.6">
          You've been invited to join the <strong>${team}</strong> workspace on Hoppscotch.<br><br>
          Click the button below — it will sign you in automatically and open the workspace.
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 28px">
          <tr><td style="background:#2f9e44;border-radius:7px">
            <a href="${acceptUrl}" style="display:inline-block;padding:13px 32px;font-size:15px;font-weight:600;color:#fff;text-decoration:none">
              Join ${team} &rarr;
            </a>
          </td></tr>
        </table>
        <p style="margin:0 0 6px;font-size:12px;color:#888">Or copy this URL:</p>
        <p style="margin:0;font-size:11px;color:#2f9e44;word-break:break-all">${acceptUrl}</p>
      </td></tr>
      <tr><td style="background:#f8f9fa;padding:20px 40px;border-top:1px solid #eee">
        <p style="margin:0;font-size:11px;color:#aaa">
          If you weren't expecting this invitation, you can safely ignore this email.<br>
          &copy; ${new Date().getFullYear()} PaysysLabs &mdash; watcher@paysyslabs.com
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// ── SMTP Server ───────────────────────────────────────────────
const suppressedTokens = new Set();

const smtpServer = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],

    onData(stream, session, callback) {
        simpleParser(stream, {}, async (err, mail) => {
            if (err) return callback(new Error('Parse failed'));

            const to      = mail.to?.value?.[0];
            const toEmail = to?.address || '';
            const toName  = to?.name || toEmail;
            const subject = mail.subject || '';

            if (!toEmail) return callback();

            const joinUrl = extractJoinTeamUrl(mail.text, mail.html);
            if (joinUrl) {
                const inviteId = extractJoinTeamId(joinUrl);
                let teamName   = null;
                if (inviteId) {
                    const info = await getInviteInfo(inviteId);
                    if (info) teamName = info.team_name;
                }
                const acceptUrl = inviteId
                    ? `${PUBLIC_URL}/accept-invite?id=${inviteId}`
                    : joinUrl;
                try {
                    await callEmailApi(
                        toName, toEmail,
                        `You've been invited to join ${teamName || 'a workspace'} on Hoppscotch`,
                        buildInviteHtml(toName, teamName, acceptUrl)
                    );
                } catch (e) {
                    console.error('[smtp-bridge] Invite email failed:', e.message);
                }
                return callback();
            }

            const magicUrl = extractMagicUrl(mail.text, mail.html);
            if (!magicUrl) {
                try { await callEmailApi(toName, toEmail, subject, mail.text || ''); } catch (_) {}
                return callback();
            }

            const token = extractToken(magicUrl);

            if (token && suppressedTokens.has(token)) {
                suppressedTokens.delete(token);
                console.log(`[smtp-bridge] Suppressed internal signin email for ${toEmail}`);
                return callback();
            }

            const deviceId = token ? await getExistingDeviceHash(token) : null;
            const admin    = await isAdminUser(toEmail);
            const baseUrl  = deviceId
                ? `${PUBLIC_URL}/magic-login?token=${encodeURIComponent(token)}&d=${encodeURIComponent(deviceId)}`
                : magicUrl;

            try {
                if (admin) {
                    await callEmailApi(toName, toEmail, 'Sign in to PaysysLabs — Admin & User Access',
                        buildAdminSignInHtml(toName, baseUrl + '&admin=1', baseUrl));
                } else {
                    await callEmailApi(toName, toEmail, subject || 'Sign in to Hoppscotch',
                        buildSignInHtml(toName, baseUrl));
                }
            } catch (e) {
                console.error('[smtp-bridge] Sign-in email failed:', e.message);
            }

            callback();
        });
    }
});
smtpServer.on('error', e => console.error('[smtp-bridge] SMTP error:', e.message));
smtpServer.listen(1025, '0.0.0.0', () => console.log('[smtp-bridge] SMTP on :1025'));

// ── HTTP Server — port 8026 ───────────────────────────────────
const httpServer = http.createServer(async (req, res) => {

    // ── /github-start → initiate GitHub OAuth ────────────────
    // nginx routes GET /api/auth/github (exact match) here.
    if (req.url === '/github-start' || req.url.startsWith('/github-start?')) {
        if (!GITHUB_CLIENT_ID) {
            res.writeHead(302, { Location: `${PUBLIC_URL}/?error=github_not_configured`, 'Cache-Control': 'no-store' });
            return res.end();
        }
        cleanupStates();
        const state = crypto.randomBytes(20).toString('hex');
        githubStateMap.set(state, Date.now());
        const authUrl = 'https://github.com/login/oauth/authorize?' + new URLSearchParams({
            client_id:    GITHUB_CLIENT_ID,
            scope:        'user:email',
            redirect_uri: GITHUB_CALLBACK_URL,
            state,
        });
        console.log(`[smtp-bridge] GitHub auth start state=${state.slice(0, 8)}...`);
        res.writeHead(302, { Location: authUrl, 'Cache-Control': 'no-store' });
        return res.end();
    }

    // ── /github-callback → complete GitHub OAuth ──────────────
    // nginx routes GET /api/auth/github/callback here.
    // Full custom flow: code → token → emails → signin → verify → cookies.
    if (req.url.startsWith('/github-callback')) {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const code   = params.get('code');
        const state  = params.get('state');
        const ghErr  = params.get('error');

        if (ghErr) {
            console.error(`[smtp-bridge] GitHub denied: ${ghErr}`);
            res.writeHead(302, { Location: `${PUBLIC_URL}/?error=github_denied`, 'Cache-Control': 'no-store' });
            return res.end();
        }

        // CSRF state check
        if (!state || !githubStateMap.has(state)) {
            console.error('[smtp-bridge] GitHub callback: invalid/expired state');
            res.writeHead(302, { Location: `${PUBLIC_URL}/?error=github_state`, 'Cache-Control': 'no-store' });
            return res.end();
        }
        githubStateMap.delete(state);

        if (!code) {
            res.writeHead(302, { Location: `${PUBLIC_URL}/?error=github_no_code`, 'Cache-Control': 'no-store' });
            return res.end();
        }

        try {
            // Step 1: exchange code for GitHub access token
            const accessToken = await exchangeGithubCode(code);

            // Step 2: fetch all emails from GitHub API
            const emails = await getGithubEmails(accessToken);
            console.log(`[smtp-bridge] GitHub emails: ${JSON.stringify(
                emails.map(e => ({ email: e.email, primary: e.primary, verified: e.verified }))
            )}`);

            const email = pickBestEmail(emails);
            if (!email) {
                console.error('[smtp-bridge] GitHub: no usable email returned');
                res.writeHead(302, { Location: `${PUBLIC_URL}/?error=github_no_email`, 'Cache-Control': 'no-store' });
                return res.end();
            }
            console.log(`[smtp-bridge] GitHub login for: ${email}`);

            // Step 3: trigger Hoppscotch email signin (creates VerificationToken)
            const signinResult = await callBackendSignin(email);
            if (signinResult.status !== 200 && signinResult.status !== 201) {
                console.error(`[smtp-bridge] Signin failed: ${signinResult.status}: ${signinResult.body}`);
                res.writeHead(302, { Location: `${PUBLIC_URL}/?error=github_signin_failed`, 'Cache-Control': 'no-store' });
                return res.end();
            }

            const { deviceIdentifier: storedHash } = JSON.parse(signinResult.body);
            const token = await getTokenByHash(storedHash);
            if (!token) {
                console.error('[smtp-bridge] GitHub: no verification token found');
                res.writeHead(302, { Location: `${PUBLIC_URL}/?error=github_no_token`, 'Cache-Control': 'no-store' });
                return res.end();
            }

            // Suppress the magic-link email — we're logging in directly
            suppressedTokens.add(token);
            setTimeout(() => suppressedTokens.delete(token), 60_000);

            // Step 4: verify token → get auth cookies
            const verifyResult = await callBackendVerify(token, storedHash);
            if (verifyResult.status !== 200 && verifyResult.status !== 201) {
                console.error(`[smtp-bridge] Verify failed: ${verifyResult.status}: ${verifyResult.body}`);
                res.writeHead(302, { Location: `${PUBLIC_URL}/?error=github_verify_failed`, 'Cache-Control': 'no-store' });
                return res.end();
            }

            const fixedCookies = [].concat(verifyResult.headers['set-cookie'] || []).map(rewriteCookie);

            // Step 5: redirect non-admins to main app; show admins a choice page
            const admin = await isAdminUser(email);
            console.log(`[smtp-bridge] GitHub OK: ${email} admin=${admin}`);

            if (admin) {
                // Serve an HTML page with cookies — user picks admin or app portal
                const html = buildChoosePortalHtml(ADMIN_URL, PUBLIC_URL);
                const buf  = Buffer.from(html, 'utf8');
                res.writeHead(200, {
                    'Content-Type':   'text/html; charset=utf-8',
                    'Content-Length': buf.length,
                    'Set-Cookie':     fixedCookies,
                    'Cache-Control':  'no-store',
                });
                return res.end(buf);
            }

            res.writeHead(302, {
                Location:        PUBLIC_URL,
                'Set-Cookie':    fixedCookies,
                'Cache-Control': 'no-store',
            });
            return res.end();

        } catch (e) {
            console.error('[smtp-bridge] GitHub callback error:', e.message);
            res.writeHead(302, { Location: `${PUBLIC_URL}/?error=github_internal`, 'Cache-Control': 'no-store' });
            return res.end();
        }
    }

    // ── /accept-invite ────────────────────────────────────────
    if (req.url.startsWith('/accept-invite')) {
        const params   = new URL(req.url, 'http://localhost').searchParams;
        const inviteId = params.get('id');

        if (!inviteId) {
            res.writeHead(302, { Location: PUBLIC_URL });
            return res.end();
        }

        const info = await getInviteInfo(inviteId);
        if (!info) {
            console.warn(`[smtp-bridge] Invite not found: ${inviteId}`);
            res.writeHead(302, { Location: `${PUBLIC_URL}/?invite_error=not_found`, 'Cache-Control': 'no-store' });
            return res.end();
        }

        const { team_name, inviteeEmail } = info;
        console.log(`[smtp-bridge] Accept invite: ${inviteeEmail} → ${team_name}`);

        try {
            const signinResult = await callBackendSignin(inviteeEmail);
            if (signinResult.status === 200 || signinResult.status === 201) {
                const { deviceIdentifier: storedHash } = JSON.parse(signinResult.body);
                const token = await getTokenByHash(storedHash);
                if (token) {
                    suppressedTokens.add(token);
                    setTimeout(() => suppressedTokens.delete(token), 60000);
                    const redirect = encodeURIComponent('/join-team?id=' + inviteId);
                    const dest = `${PUBLIC_URL}/magic-login?token=${encodeURIComponent(token)}&d=${encodeURIComponent(storedHash)}&redirect=${redirect}`;
                    res.writeHead(302, { Location: dest, 'Cache-Control': 'no-store' });
                    return res.end();
                }
                console.error('[smtp-bridge] Token not found for hash after signin');
            } else {
                console.error(`[smtp-bridge] Signin for invite failed ${signinResult.status}: ${signinResult.body}`);
            }
        } catch (e) {
            console.error('[smtp-bridge] Accept invite error:', e.message);
        }

        res.writeHead(302, { Location: `${PUBLIC_URL}/join-team?id=${inviteId}`, 'Cache-Control': 'no-store' });
        return res.end();
    }

    // ── /magic-login ──────────────────────────────────────────
    if (req.url.startsWith('/magic-login')) {
        const params       = new URL(req.url, 'http://localhost').searchParams;
        const token        = params.get('token');
        const deviceId     = params.get('d');
        const redirectPath = params.get('redirect');
        const isAdmin      = params.get('admin') === '1';

        if (!token || !deviceId) {
            res.writeHead(302, { Location: PUBLIC_URL });
            return res.end();
        }

        let destination = isAdmin ? ADMIN_URL : PUBLIC_URL;
        if (!isAdmin && redirectPath && redirectPath.startsWith('/') && !redirectPath.startsWith('//')) {
            destination = PUBLIC_URL + redirectPath;
        }

        try {
            const result = await callBackendVerify(token, deviceId);

            if (result.status !== 200 && result.status !== 201) {
                console.error(`[smtp-bridge] Verify failed ${result.status}: ${result.body}`);
                res.writeHead(302, { Location: `${PUBLIC_URL}/?magic_error=link_expired`, 'Cache-Control': 'no-store' });
                return res.end();
            }

            const fixedCookies = [].concat(result.headers['set-cookie'] || []).map(rewriteCookie);
            console.log(`[smtp-bridge] Magic login OK — ${fixedCookies.length} cookies → ${destination}`);

            res.writeHead(302, {
                Location:        destination,
                'Set-Cookie':    fixedCookies,
                'Cache-Control': 'no-store',
            });
            return res.end();

        } catch (e) {
            console.error('[smtp-bridge] Magic login error:', e.message);
            res.writeHead(302, { Location: PUBLIC_URL });
            return res.end();
        }
    }

    res.writeHead(404);
    res.end();
});

httpServer.on('error', e => console.error('[smtp-bridge] HTTP error:', e.message));
httpServer.listen(8026, '0.0.0.0', () => {
    console.log('[smtp-bridge] HTTP on :8026');
    console.log(`[smtp-bridge] PUBLIC_URL:  ${PUBLIC_URL}`);
    console.log(`[smtp-bridge] BACKEND_URL: ${BACKEND_URL}`);
    console.log(`[smtp-bridge] GitHub:      ${GITHUB_CLIENT_ID ? 'configured' : 'NOT configured — set GITHUB_CLIENT_ID'}`);
});
