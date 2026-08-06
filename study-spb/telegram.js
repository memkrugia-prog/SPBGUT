const crypto = require('crypto');
require('dotenv').config();
const TOKEN = process.env.BOT_TOKEN;

const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  }).then(r => r.json());

function verifyAuth(data){
  const { hash, ...rest } = data;
  const check = Object.keys(rest)
    .filter(k => rest[k] !== undefined && rest[k] !== '')
    .sort().map(k => `${k}=${rest[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  // защита от старых auth_date (не старше 1 дня)
  if(data.auth_date && (Date.now()/1000 - data.auth_date) > 86400) return false;
  return calc === hash;
}

const sendMessage = (chat_id, text) => api('sendMessage', { chat_id, text, parse_mode:'HTML' });
const setWebhook = (url) => api('setWebhook', { url });

module.exports = { api, verifyAuth, sendMessage, setWebhook };