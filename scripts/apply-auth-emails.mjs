// Applies branded Supabase Auth email templates + redirect URLs.
// Usage: node scripts/apply-auth-emails.mjs   (reads SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF from .env)
//
// Links point straight at the dashboard with a token_hash; the dashboard verifies it with
// supabase.auth.verifyOtp(). This avoids redirect problems and email scanners consuming links.
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const DASHBOARD = 'https://coco-voice-dashboard.vercel.app';
const BRAND = 'Coco Voice';

const link = (type) => `{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=${type}`;

function layout({ preheader, title, intro, button, href, code = true, note }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:'DM Sans',Arial,Helvetica,sans-serif;">
    <tr><td style="background:#000000;padding:22px 32px;">
      <span style="font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-size:22px;font-weight:700;letter-spacing:1px;color:#ffffff;text-transform:uppercase;">COCO <span style="color:#ffba00;">VOICE</span></span>
    </td></tr>
    <tr><td style="height:4px;background:#ffba00;line-height:4px;font-size:0;">&nbsp;</td></tr>
    <tr><td style="padding:32px 32px 8px;">
      <h1 style="margin:0 0 12px;font-family:Oswald,'Arial Narrow',Arial,sans-serif;font-size:24px;line-height:1.2;color:#111111;text-transform:uppercase;letter-spacing:.5px;">${title}</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#444444;">${intro}</p>
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:#ffba00;">
        <a href="${href}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#000000;text-decoration:none;border-radius:8px;">${button}</a>
      </td></tr></table>
      ${code ? `<p style="margin:28px 0 6px;font-size:13px;color:#666666;">Or enter this code on the sign-in page:</p>
      <div style="display:inline-block;padding:10px 16px;background:#f4f4f4;border:1px dashed #ffba00;border-radius:8px;font-family:'Courier New',monospace;font-size:22px;font-weight:700;letter-spacing:4px;color:#111111;">{{ .Token }}</div>` : ''}
      <p style="margin:28px 0 0;font-size:13px;line-height:1.6;color:#666666;">${note}</p>
    </td></tr>
    <tr><td style="padding:24px 32px 28px;">
      <p style="margin:0;padding-top:16px;border-top:1px solid #eeeeee;font-size:12px;line-height:1.6;color:#999999;">
        If you didn't request this, you can safely ignore this email — nothing will change.<br>
        ${BRAND} · Team activity dashboard · <a href="${DASHBOARD}" style="color:#b38200;text-decoration:none;">coco-voice-dashboard.vercel.app</a>
      </p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

const expire = 'This link and code expire in 60 minutes and can be used once.';
const T = {
  confirmation: {
    subject: `Confirm your email — ${BRAND}`,
    html: layout({
      preheader: 'Confirm your email to open the Coco Voice dashboard.',
      title: 'Confirm your email',
      intro: 'Welcome to the Coco Voice dashboard. Confirm <b>{{ .Email }}</b> to sign in and see your team\'s calls, texts and coaching reports.',
      button: 'Confirm &amp; sign in', href: link('email'), note: expire,
    }),
  },
  magic_link: {
    subject: `Your sign-in link — ${BRAND}`,
    html: layout({
      preheader: 'Your one-time link to sign in to Coco Voice.',
      title: 'Sign in to Coco Voice',
      intro: 'Click the button below to sign in as <b>{{ .Email }}</b>.',
      button: 'Sign in to dashboard', href: link('magiclink'), note: expire,
    }),
  },
  invite: {
    subject: `You're invited to ${BRAND}`,
    html: layout({
      preheader: 'You have been invited to the Coco Voice dashboard.',
      title: "You're invited",
      intro: 'You have been invited to the Coco Voice dashboard, where your team tracks Google Voice outreach and coaching.',
      button: 'Accept invite', href: link('invite'), code: false,
      note: 'This invite link expires in 24 hours.',
    }),
  },
  recovery: {
    subject: `Reset your password — ${BRAND}`,
    html: layout({
      preheader: 'Reset your Coco Voice password.',
      title: 'Reset your password',
      intro: 'We received a request to reset the password for <b>{{ .Email }}</b>. Click the button to choose a new password.',
      button: 'Reset password', href: link('recovery'), code: false,
      note: 'This link expires in 60 minutes and can be used once. Your current password keeps working until you set a new one.',
    }),
  },
  email_change: {
    subject: `Confirm your new email — ${BRAND}`,
    html: layout({
      preheader: 'Confirm the change of your Coco Voice email address.',
      title: 'Confirm email change',
      intro: 'Confirm changing your sign-in email from <b>{{ .Email }}</b> to <b>{{ .NewEmail }}</b>.',
      button: 'Confirm new email', href: link('email_change'), note: expire,
    }),
  },
  reauthentication: {
    subject: `{{ .Token }} is your ${BRAND} code`,
    html: layout({
      preheader: 'Your Coco Voice verification code.',
      title: 'Verification code',
      intro: 'Use the code below to confirm it\'s you.',
      button: 'Open dashboard', href: DASHBOARD, note: 'This code expires in 60 minutes.',
    }),
  },
};

// Security notices (no link to click, just information).
const notice = (title, intro, preheader) => layout({
  preheader, title, intro, button: 'Open dashboard', href: DASHBOARD, code: false,
  note: "If this wasn't you, reset your password from the sign-in page right away and tell your admin.",
});
const N = {
  password_changed_notification: {
    subject: `Your password was changed — ${BRAND}`,
    html: notice('Password changed', 'The password for <b>{{ .Email }}</b> was just changed.', 'Your Coco Voice password was changed.'),
  },
  email_changed_notification: {
    subject: `Your sign-in email was changed — ${BRAND}`,
    html: notice('Email changed', 'The sign-in email for your account was changed from <b>{{ .OldEmail }}</b> to <b>{{ .Email }}</b>.', 'Your Coco Voice sign-in email was changed.'),
  },
};

const body = {
  site_url: DASHBOARD,
  password_min_length: 6,
  password_required_characters: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789', // letters + digits
  mailer_notifications_password_changed_enabled: true,
  mailer_notifications_email_changed_enabled: true,
  uri_allow_list: `${DASHBOARD}/**,https://coco-voice-dashboard-jelly-bean2.vercel.app/**`,
};
for (const [k, v] of Object.entries({ ...T, ...N })) {
  body[`mailer_subjects_${k}`] = v.subject;
  body[`mailer_templates_${k}_content`] = v.html;
}

// --smtp: also configure the custom SMTP sender from .env (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SENDER_NAME)
if (process.argv.includes('--smtp')) {
  const need = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) { console.error('Missing in .env:', missing.join(', ')); process.exit(1); }
  Object.assign(body, {
    smtp_host: env.SMTP_HOST, smtp_port: String(env.SMTP_PORT), smtp_user: env.SMTP_USER, smtp_pass: env.SMTP_PASS,
    smtp_admin_email: env.SMTP_FROM, smtp_sender_name: env.SMTP_SENDER_NAME || BRAND,
    rate_limit_email_sent: 30,
  });
}

if (process.argv.includes('--preview')) {
  const out = new URL('../.email-preview.html', import.meta.url);
  const pick = T[process.argv[3]] || N[process.argv[3]] || T.magic_link;
  fs.writeFileSync(out, pick.html.replaceAll('{{ .Token }}', '12345678').replaceAll('{{ .Email }}', 'you@company.com')
    .replaceAll('{{ .SiteURL }}', DASHBOARD).replaceAll('{{ .TokenHash }}', 'preview'));
  console.log('preview written to', out.pathname);
  process.exit(0);
}

const API = `https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/config/auth`;
const headers = { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
const patch = async (b) => {
  const r = await fetch(API, { method: 'PATCH', headers, body: JSON.stringify(b) });
  const out = await r.json();
  if (!r.ok) { console.error(r.status, out); process.exit(1); }
  return out;
};

// 1) Settings that work on every plan.
const settings = Object.fromEntries(Object.entries(body).filter(([k]) => !/^mailer_(subjects|templates|notifications)_/.test(k)));
let j = await patch(settings);
console.log('site_url:', j.site_url, '| min password length:', j.password_min_length, '| required:', j.password_required_characters);

// 2) Branded templates + security notices: Supabase requires a custom SMTP sender for these (free plan).
if (!j.smtp_host) {
  console.log('Templates NOT applied: configure custom SMTP first (Supabase > Auth > SMTP, or add SMTP_* to .env and run with --smtp).');
  process.exit(0);
}
j = await patch(Object.fromEntries(Object.entries(body).filter(([k]) => /^mailer_(subjects|templates|notifications)_/.test(k))));
for (const k of Object.keys({ ...T, ...N })) console.log(`${k}:`, j[`mailer_subjects_${k}`], '| custom:', j.mailer_templates_custom_contents?.[`MAILER_TEMPLATES_${k.toUpperCase()}_CONTENT`]);
