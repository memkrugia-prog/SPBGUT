const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();
const db = require('./db');
const tg = require('./telegram');
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname,'public')));
const PORT = process.env.PORT || 3000;
const ADMIN_IDS = (process.env.ADMIN_TG_IDS||'').split(',').map(s=>s.trim()).filter(Boolean).map(Number);
const VERSION = '0.5.0';
const REMIND_HOUR_MOSCOW = parseInt(process.env.REMIND_HOUR || '19');
const MOSCOW_OFFSET = 3;
// Дата и время текущей версии проставляются автоматически при каждом деплое/рестарте
const BUILD_DATE = new Date().toLocaleString('ru', {
  day:'2-digit', month:'2-digit', year:'numeric',
  hour:'2-digit', minute:'2-digit', timeZone:'Europe/Moscow'
}).replace(',','');
const CHANGELOG = [
 { v:'0.5.0', date:BUILD_DATE, notes:['📚 Домашка: не знаешь слово на карточке → обязательное задание (справочник + тест)','💀 Пропуск дня = −1500 рейтинга','🧠 Умный SRS: неузнанные долбят каждые 5 мин, узнанные уходят на дни','📊 Статистика карточек: счётчики Узнано / Не узнано']},
 { v:'0.4.0', date:'ранее', notes:['🃏 Карточки с переворотом + бесконечный режим','🧠 SRS: сложные слова возвращаются чаще','📖 Развёрнутые нюансы и синонимы','🟢 Баланс сложности','🔤 Шрифт Manrope']},
 { v:'0.3.1', date:'ранее', notes:['Авто-рассылка changelog','Команда /version']},
 { v:'0.3.0', date:'ранее', notes:['Рассылка 19:00 МСК','Таймер 24ч','Категории']},
 { v:'0.2.0', date:'ранее', notes:['Railway + PostgreSQL, Telegram OAuth']},
 { v:'0.1.0', date:'ранее', notes:['Первый релиз']}
];

const today = () => new Date().toISOString().slice(0,10);
const addDays = (d,n) => { const x=new Date(d+'T00:00:00'); x.setDate(x.getDate()+n); return x.toISOString().slice(0,10); };

// ─── Умный SRS: интервалы ────────────────────────────────────────────────────
// Неузнанные слова: 5м → 30м → 2ч → 6ч → 1д → 3д
const UNKNOWN_INTERVALS = [5, 30, 120, 360, 1440, 4320];
// Узнанные слова:  1д → 2д → 4д → 7д → 7д (потолок)
const KNOWN_INTERVALS   = [1440, 2880, 5760, 10080, 10080];

function unknownInterval(unknownCount){
  return UNKNOWN_INTERVALS[Math.min(unknownCount, UNKNOWN_INTERVALS.length) - 1] || 5;
}
function knownInterval(knownCount){
  return KNOWN_INTERVALS[Math.min(knownCount, KNOWN_INTERVALS.length) - 1] || 10080;
}

// ─── Штрафы ─────────────────────────────────────────────────────────────────
async function applyHomeworkPenalties(userId){
  // Находим просроченные домашки (stage < 2, due_at прошёл, ещё не штрафовали)
  const overdue = (await db.q(
    `SELECT word_id FROM homework WHERE user_id=$1 AND stage < 2 AND due_at < NOW() AND penalized=FALSE`,
    [userId]
  )).rows;
  for(const hw of overdue){
    await db.q('UPDATE users SET rating=GREATEST(0,rating-100) WHERE id=$1', [userId]);
    // Перенести дедлайн на +24ч, сбросить флаг штрафа для следующей проверки
    await db.q(
      `UPDATE homework SET penalized=TRUE, due_at=NOW()+'24 hours'::interval
       WHERE user_id=$1 AND word_id=$2`,
      [userId, hw.word_id]
    );
  }
}

async function applyPenaltiesFor(userId){
  const u = (await db.q('SELECT * FROM users WHERE id=$1',[userId])).rows[0];
  if(!u || !u.last_dict_at) return;
  const diff = (Date.now() - new Date(u.last_dict_at).getTime()) / 36e5; // часов
  if(diff > 24){
    const missCount = Math.floor(diff / 24) - 1; // кол-во полных пропущенных дней сверх первых 24ч
    if(missCount > 0){
      // −1500 за каждый пропущенный день (вместо старых −50)
      await db.q('UPDATE users SET rating=GREATEST(0,rating-$1) WHERE id=$2', [missCount * 1500, userId]);
    }
  }
  await applyHomeworkPenalties(userId);
}

async function applyAllPenalties(){
  const us = (await db.q('SELECT id FROM users')).rows;
  for(const u of us) await applyPenaltiesFor(u.id);
}

// ─── Вспомогательные ────────────────────────────────────────────────────────
async function addActivity(userId,{points=0,answered=0,correct=0,dictations=0}){
  await db.q(`INSERT INTO activity(user_id,day,points,answered,correct,dictations) VALUES($1,CURRENT_DATE,$2,$3,$4,$5)
    ON CONFLICT(user_id,day) DO UPDATE SET points=activity.points+EXCLUDED.points, answered=activity.answered+EXCLUDED.answered,
    correct=activity.correct+EXCLUDED.correct, dictations=activity.dictations+EXCLUDED.dictations`,
    [userId,points,answered,correct,dictations]);
}
async function addRating(userId,n){ await db.q('UPDATE users SET rating=rating+$1 WHERE id=$2',[n,userId]); }
async function createSession(userId){
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now()+30*864e5);
  await db.q('INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,$3)',[token,userId,exp]);
  return token;
}
async function auth(req,res,next){
  const token = req.cookies.sid;
  if(!token) return res.status(401).json({error:'unauthorized'});
  const s = (await db.q('SELECT * FROM sessions WHERE token=$1',[token])).rows[0];
  if(!s || new Date(s.expires_at)<new Date()) return res.status(401).json({error:'session expired'});
  const u = (await db.q('SELECT * FROM users WHERE id=$1',[s.user_id])).rows[0];
  if(!u) return res.status(401).json({error:'no user'});
  req.user = u; next();
}
function adminOnly(req,res,next){ if(!req.user.is_admin) return res.status(403).json({error:'admin only'}); next(); }

// ─── Config / Auth ───────────────────────────────────────────────────────────
app.get('/api/config',(req,res)=>{
  const tokenParts = (process.env.BOT_TOKEN||'').split(':');
  res.json({ botUsername:process.env.BOT_USERNAME, botId:tokenParts[0]||'', version:VERSION, remindHour:REMIND_HOUR_MOSCOW });
});
async function upsertUser(data){
  const isAdmin = ADMIN_IDS.includes(Number(data.id));
  const count = (await db.q('SELECT COUNT(*)::int n FROM users')).rows[0].n;
  const makeAdmin = isAdmin || count===0;
  await db.q(`INSERT INTO users(tg_id,username,first_name,last_name,photo,is_admin,last_check)
    VALUES($1,$2,$3,$4,$5,$6,CURRENT_DATE)
    ON CONFLICT(tg_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,
      last_name=EXCLUDED.last_name,photo=EXCLUDED.photo`,
    [data.id,data.username||null,data.first_name||null,data.last_name||null,data.photo_url||null,makeAdmin]);
  return (await db.q('SELECT * FROM users WHERE tg_id=$1',[data.id])).rows[0];
}
app.get('/auth/telegram', async (req,res)=>{
  try{
    const data = req.query;
    if(!tg.verifyAuth(data)) return res.redirect('/?error=bad_hash');
    const u = await upsertUser(data);
    const token = await createSession(u.id);
    res.cookie('sid',token,{ httpOnly:true, sameSite:'lax', maxAge:30*864e5, secure:process.env.NODE_ENV==='production' });
    res.redirect('/');
  }catch(e){ console.error('auth error',e); res.redirect('/?error=server'); }
});
app.post('/auth/telegram', async (req,res)=>{
  try{
    const data = req.body;
    if(!tg.verifyAuth(data)) return res.status(400).json({error:'bad hash'});
    const u = await upsertUser(data);
    const token = await createSession(u.id);
    res.cookie('sid',token,{ httpOnly:true, sameSite:'lax', maxAge:30*864e5, secure:process.env.NODE_ENV==='production' });
    res.json({ user:{ id:u.id, name:(u.first_name||u.username||'User'), username:u.username, isAdmin:u.is_admin } });
  }catch(e){ console.error('auth error',e); res.status(500).json({error:'server error'}); }
});
app.post('/auth/logout',(req,res)=>{ res.clearCookie('sid'); res.json({ok:true}); });

// ─── Me / Words ──────────────────────────────────────────────────────────────
app.get('/api/me', auth, async (req,res)=>{
  await applyPenaltiesFor(req.user.id);
  const u = (await db.q('SELECT * FROM users WHERE id=$1',[req.user.id])).rows[0];
  let nextDeadline = null;
  if(u.last_dict_at) nextDeadline = new Date(u.last_dict_at).getTime() + 24*36e5;
  // Считаем открытые домашки
  const hw = (await db.q('SELECT COUNT(*)::int n FROM homework WHERE user_id=$1 AND stage < 2',[u.id])).rows[0].n;
  res.json({ user:{ id:u.id, name:(u.first_name||u.username||'User'), username:u.username, isAdmin:u.is_admin, rating:u.rating, streak:u.streak }, lastDictAt:u.last_dict_at, nextDeadline, remindHour:REMIND_HOUR_MOSCOW, openHomework:hw });
});
app.get('/api/words', auth, async (req,res)=>{
  const diff = req.query.difficulty;
  let q_str = 'SELECT * FROM words'; const params = [];
  if(diff && diff!=='all'){ q_str += ' WHERE difficulty=$1'; params.push(parseInt(diff)); }
  q_str += ' ORDER BY id DESC';
  const { rows } = await db.q(q_str, params);
  res.json(rows);
});
app.post('/api/words', auth, async (req,res)=>{
  const { en, ru, note, difficulty, synonyms } = req.body;
  if(!en||!ru) return res.status(400).json({error:'en/ru required'});
  const diff = parseInt(difficulty)||2;
  const { rows } = await db.q('INSERT INTO words(en,ru,note,difficulty,synonyms,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[en,ru,note||null,diff,synonyms||null,req.user.id]);
  res.json(rows[0]);
});
app.delete('/api/words/:id', auth, adminOnly, async (req,res)=>{
  await db.q('DELETE FROM words WHERE id=$1',[req.params.id]); res.json({ok:true});
});

// ─── Answer (карточки) — умный SRS ──────────────────────────────────────────
// source: 'card' | 'dictation' | другое
// Только 'card' влияет на known_count/unknown_count и домашку
app.post('/api/answer', auth, async (req,res)=>{
  const { word_id, mode, correct, source } = req.body;
  const uid = req.user.id;
  await db.q('INSERT INTO answers(user_id,word_id,mode,correct) VALUES($1,$2,$3,$4)',[uid,word_id,mode,correct]);
  const pts = correct ? 10 : 0;
  if(pts) await addRating(uid, pts);
  await addActivity(uid,{points:pts,answered:1,correct:correct?1:0});

  if(source === 'card'){
    // Получаем текущую запись SRS
    const cur = (await db.q('SELECT * FROM srs WHERE user_id=$1 AND word_id=$2',[uid,word_id])).rows[0];
    const knownCount   = (cur?.known_count   || 0);
    const unknownCount = (cur?.unknown_count || 0);

    if(correct){
      // ✅ Узнал: +1 known, сбрасываем unknown, планируем редко
      const newKnown = knownCount + 1;
      const mins = knownInterval(newKnown);
      await db.q(
        `INSERT INTO srs(user_id,word_id,known_count,unknown_count,errors,next_review)
         VALUES($1,$2,$3,0,0,NOW()+($4||' minutes')::interval)
         ON CONFLICT(user_id,word_id) DO UPDATE
           SET known_count=$3, unknown_count=0, errors=0,
               next_review=NOW()+($4||' minutes')::interval`,
        [uid, word_id, newKnown, mins]
      );
      // Если слово было на стадии 1 в домашке — закрываем
      await db.q(
        `UPDATE homework SET stage=2 WHERE user_id=$1 AND word_id=$2 AND stage=1`,
        [uid, word_id]
      );
    } else {
      // ❌ Не узнал: +1 unknown, сбрасываем known, планируем часто
      const newUnknown = unknownCount + 1;
      const mins = unknownInterval(newUnknown);
      await db.q(
        `INSERT INTO srs(user_id,word_id,known_count,unknown_count,errors,next_review)
         VALUES($1,$2,0,$3,$3,NOW()+($4||' minutes')::interval)
         ON CONFLICT(user_id,word_id) DO UPDATE
           SET known_count=0, unknown_count=$3, errors=$3,
               next_review=NOW()+($4||' minutes')::interval`,
        [uid, word_id, newUnknown, mins]
      );
      // Добавляем в домашку (если ещё не открыта)
      await db.q(
        `INSERT INTO homework(user_id,word_id,stage,due_at)
         VALUES($1,$2,0,NOW()+'48 hours'::interval)
         ON CONFLICT(user_id,word_id) DO NOTHING`,
        [uid, word_id]
      );
    }
  } else {
    // Старая логика для не-карточек (диктант/тест)
    if(!correct){
      const cur = (await db.q('SELECT errors FROM srs WHERE user_id=$1 AND word_id=$2',[uid,word_id])).rows[0];
      const e = (cur?cur.errors:0)+1;
      const mins = [10,60,360,1440,4320,10080][Math.min(e,6)-1] || 10080;
      await db.q(
        `INSERT INTO srs(user_id,word_id,errors,next_review) VALUES($1,$2,$3,NOW()+($4||' minutes')::interval)
         ON CONFLICT(user_id,word_id) DO UPDATE SET errors=$3, next_review=NOW()+($4||' minutes')::interval`,
        [uid,word_id,e,mins]
      );
    } else {
      await db.q(`UPDATE srs SET errors=GREATEST(0,errors-1) WHERE user_id=$1 AND word_id=$2`,[uid,word_id]);
      await db.q(`DELETE FROM srs WHERE user_id=$1 AND word_id=$2 AND errors=0`,[uid,word_id]);
    }
  }
  res.json({ ok:true });
});

// ─── Dictation ───────────────────────────────────────────────────────────────
app.post('/api/dictation', auth, async (req,res)=>{
  const { total, correct, difficulty } = req.body;
  let bonus = 20; if(correct===total) bonus+=30;
  if(difficulty==3) bonus += 15; else if(difficulty==2) bonus += 5;
  await addRating(req.user.id,bonus);
  await addActivity(req.user.id,{points:bonus,dictations:1});
  await db.q('INSERT INTO dictations(user_id,total,correct,points,difficulty) VALUES($1,$2,$3,$4,$5)',[req.user.id,total,correct,bonus,difficulty||2]);
  const u = (await db.q('SELECT * FROM users WHERE id=$1',[req.user.id])).rows[0];
  const t = today();
  const lastDay = u.last_dict_at ? new Date(u.last_dict_at).toISOString().slice(0,10) : null;
  let streak = u.streak;
  if(lastDay !== t) streak = (lastDay === addDays(t,-1)) ? u.streak+1 : 1;
  await db.q('UPDATE users SET last_dict_at=NOW(), streak=$2 WHERE id=$1',[req.user.id,streak]);
  res.json({ bonus });
});

// ─── SRS ─────────────────────────────────────────────────────────────────────
app.get('/api/srs/due', auth, async (req,res)=>{
  const { rows } = await db.q(
    `SELECT w.*, s.known_count, s.unknown_count FROM srs s
     JOIN words w ON w.id=s.word_id
     WHERE s.user_id=$1 AND s.next_review<=NOW()
     ORDER BY s.unknown_count DESC, s.errors DESC LIMIT 20`,
    [req.user.id]
  );
  res.json(rows);
});
app.get('/api/srs/count', auth, async (req,res)=>{
  const { rows } = await db.q(`SELECT COUNT(*)::int n FROM srs WHERE user_id=$1 AND next_review<=NOW()`,[req.user.id]);
  res.json({ due: rows[0].n });
});

// ─── Домашка (Homework) ───────────────────────────────────────────────────────

// GET /api/homework — список открытых заданий (stage < 2)
app.get('/api/homework', auth, async (req,res)=>{
  const { rows } = await db.q(
    `SELECT h.word_id, h.stage, h.due_at, h.penalized, w.en, w.ru, w.note, w.synonyms
     FROM homework h JOIN words w ON w.id=h.word_id
     WHERE h.user_id=$1 AND h.stage < 2
     ORDER BY h.due_at ASC`,
    [req.user.id]
  );
  res.json(rows);
});

// GET /api/homework/count — количество открытых заданий
app.get('/api/homework/count', auth, async (req,res)=>{
  const { rows } = await db.q(
    `SELECT COUNT(*)::int n FROM homework WHERE user_id=$1 AND stage < 2`,
    [req.user.id]
  );
  res.json({ open: rows[0].n });
});

// POST /api/homework/:wordId/viewed — пользователь открыл слово в справочнике (stage 0 → 1)
app.post('/api/homework/:wordId/viewed', auth, async (req,res)=>{
  await db.q(
    `UPDATE homework SET stage=1 WHERE user_id=$1 AND word_id=$2 AND stage=0`,
    [req.user.id, req.params.wordId]
  );
  res.json({ ok:true });
});

// POST /api/homework/:wordId/postpone — отложить дедлайн на 24ч (можно не более 3 раз)
app.post('/api/homework/:wordId/postpone', auth, async (req,res)=>{
  const hw = (await db.q(
    `SELECT * FROM homework WHERE user_id=$1 AND word_id=$2 AND stage < 2`,
    [req.user.id, req.params.wordId]
  )).rows[0];
  if(!hw) return res.status(404).json({error:'homework not found'});
  const postpones = hw.postpone_count || 0;
  if(postpones >= 3) return res.status(400).json({error:'Лимит откладываний исчерпан (3/3)'});
  await db.q(
    `UPDATE homework SET due_at=due_at+'24 hours'::interval, postpone_count=COALESCE(postpone_count,0)+1
     WHERE user_id=$1 AND word_id=$2`,
    [req.user.id, req.params.wordId]
  );
  res.json({ ok:true, postponesLeft: 2 - postpones });
});
// ─── Тест домашки (без подсказок) ────────────────────────────────────────────
const norm=s=>(s||'').toLowerCase().replace(/[.,!?;:()«»"'\/\-–—]/g,' ').replace(/\s+/g,' ').trim();
function isOkAns(u,w){
  const us=norm(u); const targets=[w.ru]; if(w.synonyms) targets.push(w.synonyms);
  const all=targets.join(',').split(/[\/,]/).map(norm).filter(Boolean);
  return all.some(v=>us===v||us.includes(v)||v.includes(us));
}
app.post('/api/homework/test', auth, async (req,res)=>{
  const { word_id, answer } = req.body;
  const w=(await db.q('SELECT * FROM words WHERE id=$1',[word_id])).rows[0];
  if(!w) return res.status(404).json({error:'no word'});
  const ok=isOkAns(answer,w);
  if(ok){
    await db.q(`UPDATE homework SET stage=2 WHERE user_id=$1 AND word_id=$2`,[req.user.id,word_id]);
    const c=(await db.q('SELECT known_count FROM srs WHERE user_id=$1 AND word_id=$2',[req.user.id,word_id])).rows[0];
    const kc=(c?c.known_count:0)+1;
    await db.q(`INSERT INTO srs(user_id,word_id,known_count,unknown_count,errors,next_review) VALUES($1,$2,$3,0,0,NOW()+($4||' minutes')::interval) ON CONFLICT(user_id,word_id) DO UPDATE SET known_count=$3,unknown_count=0,errors=0,next_review=NOW()+($4||' minutes')::interval`,[req.user.id,word_id,kc,knownInterval(kc)]);
  } else {
    const c=(await db.q('SELECT unknown_count FROM srs WHERE user_id=$1 AND word_id=$2',[req.user.id,word_id])).rows[0];
    const uc=(c?c.unknown_count:0)+1;
    await db.q(`UPDATE srs SET unknown_count=$1,errors=$1,next_review=NOW()+($2||' minutes')::interval WHERE user_id=$3 AND word_id=$4`,[uc,unknownInterval(uc),req.user.id,word_id]);
  }
  res.json({ ok, correct: w.ru });
});
// ─── Статистика ───────────────────────────────────────────────────────────────
app.get('/api/stats', auth, async (req,res)=>{
  await applyPenaltiesFor(req.user.id);
  const uid = req.user.id;
  const u = (await db.q('SELECT * FROM users WHERE id=$1',[uid])).rows[0];
  const agg = (await db.q(
    `SELECT COALESCE(SUM(answered),0) a, COALESCE(SUM(correct),0) c, COALESCE(SUM(dictations),0) d
     FROM activity WHERE user_id=$1`,[uid]
  )).rows[0];
  const modes = (await db.q(
    `SELECT mode, COUNT(*)::int a, SUM(CASE WHEN correct THEN 1 ELSE 0 END)::int c
     FROM answers WHERE user_id=$1 GROUP BY mode`,[uid]
  )).rows;
  const m = {'en-ru':{a:0,c:0},'ru-en':{a:0,c:0}};
  modes.forEach(r=>m[r.mode]={a:r.a,c:r.c});

  // График — 7 дней
  const days=[...Array(7)].map((_,i)=>new Date(Date.now()-((6-i)*864e5)).toISOString().slice(0,10));
  const chart=[];
  for(const d of days){
    const a=(await db.q('SELECT COALESCE(points,0) p FROM activity WHERE user_id=$1 AND day=$2',[uid,d])).rows[0];
    chart.push({d,p:a?a.p:0});
  }

  // Диктант по сложности
  const diffs = (await db.q(
    `SELECT d.difficulty, COUNT(*)::int cnt, SUM(d.correct)::int corr FROM dictations d WHERE d.user_id=$1 GROUP BY d.difficulty`,[uid]
  )).rows;
  const byDiff = {1:{n:0,c:0},2:{n:0,c:0},3:{n:0,c:0}};
  diffs.forEach(r=>{ if(r.difficulty) byDiff[r.difficulty]={n:r.cnt,c:r.corr}; });

  // 📊 Статистика карточек: суммарные known/unknown из srs
  const cardAgg = (await db.q(
    `SELECT COALESCE(SUM(known_count),0)::int total_known,
            COALESCE(SUM(unknown_count),0)::int total_unknown
     FROM srs WHERE user_id=$1`,[uid]
  )).rows[0];

  // Топ-10 «упрямых» слов (самый большой unknown_count)
  const stubbornRows = (await db.q(
    `SELECT w.en, w.ru, s.unknown_count, s.known_count
     FROM srs s JOIN words w ON w.id=s.word_id
     WHERE s.user_id=$1 AND s.unknown_count > 0
     ORDER BY s.unknown_count DESC LIMIT 10`,[uid]
  )).rows;

  // Статистика домашки
  const hwStats = (await db.q(
    `SELECT
       COUNT(*)::int total,
       SUM(CASE WHEN stage=2 THEN 1 ELSE 0 END)::int done,
       SUM(CASE WHEN stage < 2 THEN 1 ELSE 0 END)::int open
     FROM homework WHERE user_id=$1`,[uid]
  )).rows[0];

  res.json({
    rating: u.rating,
    streak: u.streak,
    answered: +agg.a,
    correct: +agg.c,
    dictations: +agg.d,
    modes: m,
    chart,
    byDiff,
    cards: {
      totalKnown:   cardAgg.total_known,
      totalUnknown: cardAgg.total_unknown,
      stubborn:     stubbornRows
    },
    homework: hwStats
  });
});

// ─── Турнир ──────────────────────────────────────────────────────────────────
function periodRange(p){
  const t=today(), now=new Date();
  if(p==='day') return [t,t];
  if(p==='week'){ const mon=new Date(now); mon.setDate(mon.getDate()-((now.getDay()+6)%7)); return [mon.toISOString().slice(0,10), new Date(mon.getTime()+6*864e5).toISOString().slice(0,10)]; }
  if(p==='month') return [t.slice(0,8)+'01', new Date(now.getFullYear(),now.getMonth()+1,0).toISOString().slice(0,10)];
  return [t.slice(0,4)+'-01-01', t.slice(0,4)+'-12-31'];
}
app.get('/api/tournament', auth, async (req,res)=>{
  const [start,end]=periodRange(req.query.period||'day');
  const { rows } = await db.q(
    `SELECT u.id,u.first_name,u.username,u.streak, COALESCE(SUM(a.points),0)::int pts
     FROM users u LEFT JOIN activity a ON a.user_id=u.id AND a.day BETWEEN $1 AND $2
     GROUP BY u.id ORDER BY pts DESC`,[start,end]
  );
  res.json(rows.map(r=>({ id:r.id, name:(r.first_name||r.username||'User'), streak:r.streak, pts:r.pts, me:r.id===req.user.id })));
});

// ─── Прочее ──────────────────────────────────────────────────────────────────
app.get('/api/changelog',(req,res)=>res.json(CHANGELOG));
app.post('/api/broadcast', auth, adminOnly, async (req,res)=>{
  const chatId = await getBroadcastChat();
  if(!chatId) return res.status(400).json({error:'Сначала /setbroadcast в группе'});
  const r = await tg.sendMessage(chatId, req.body.message||'📚 StudyСПб');
  res.json({ ok:!!r.ok });
});
async function getBroadcastChat(){
  const env = process.env.BROADCAST_CHAT_ID; if(env) return env;
  const r=(await db.q("SELECT value FROM settings WHERE key='broadcast_chat_id'")).rows[0];
  return r?r.value:null;
}

// ─── Telegram Webhook ────────────────────────────────────────────────────────
app.post('/telegram/webhook', async (req,res)=>{
  res.sendStatus(200);
  const msg = req.body?.message; if(!msg) return;
  const text=(msg.text||'').trim(), chatId=msg.chat.id, from=msg.from;
  if(text.startsWith('/setbroadcast')){
    const u=(await db.q('SELECT is_admin FROM users WHERE tg_id=$1',[from.id])).rows[0];
    if(!u||!u.is_admin) return tg.sendMessage(chatId,'⛔ Только админ.');
    await db.q("INSERT INTO settings(key,value) VALUES('broadcast_chat_id',$1) ON CONFLICT(key) DO UPDATE SET value=$1",[String(chatId)]);
    return tg.sendMessage(chatId,'✅ Группа привязана.');
  }
  if(text.startsWith('/broadcast')){
    const u=(await db.q('SELECT is_admin FROM users WHERE tg_id=$1',[from.id])).rows[0];
    if(!u||!u.is_admin) return;
    const m=text.replace('/broadcast','').trim(); const target=await getBroadcastChat();
    if(target&&m) return tg.sendMessage(target,m);
  }
  if(text.startsWith('/start')) return tg.sendMessage(chatId,`Привет, ${from.first_name}! Это бот StudyСПб 📚`);
  if(text.startsWith('/version')) return tg.sendMessage(chatId,`📦 StudyСПб v${VERSION}`);
  if(text.startsWith('/help')) return tg.sendMessage(chatId,'Команды:\n/start — приветствие\n/version — версия\n/setbroadcast — (админ) привязать группу\n/broadcast <текст> — (админ) рассылка');
});

// ─── Планировщик ─────────────────────────────────────────────────────────────
let lastBroadcast='';
setInterval(async ()=>{
  try{
    const now = new Date();
    const mskHour = (now.getUTCHours() + MOSCOW_OFFSET) % 24;
    const mskMin = now.getUTCMinutes();
    const dayKey = now.toISOString().slice(0,10);
    await applyAllPenalties();
    if(mskHour === REMIND_HOUR_MOSCOW && mskMin < 2 && lastBroadcast !== dayKey){
      const chat = await getBroadcastChat();
      if(chat){
        await tg.sendMessage(chat,
          `⏰ <b>StudyСПб: время ежедневного диктанта!</b>\n\nПройди хотя бы один диктант в течение 24 часов, иначе −1500 очков.\n\n🔥 Сохрани стрик!`
        );
        lastBroadcast = dayKey;
      }
    }
  }catch(e){ console.error('scheduler',e.message); }
}, 30000);

// ─── Запуск ───────────────────────────────────────────────────────────────────
(async ()=>{
  await db.init();
  if(process.env.PUBLIC_URL) await tg.setWebhook(process.env.PUBLIC_URL+'/telegram/webhook').catch(()=>{});
  try{
    const last = (await db.q("SELECT value FROM settings WHERE key='last_broadcast_version'")).rows[0];
    const lastVersion = last ? last.value : '';
    if(lastVersion !== VERSION){
      const chat = await getBroadcastChat();
      if(chat){
        const latest = CHANGELOG[0];
        await tg.sendMessage(chat, `🚀 <b>StudyСПб обновился до v${latest.v}</b>\n\n${latest.notes.map(n=>'• '+n).join('\n')}`);
        console.log('Broadcast changelog for v'+VERSION);
      }
      await db.q("INSERT INTO settings(key,value) VALUES('last_broadcast_version',$1) ON CONFLICT(key) DO UPDATE SET value=$1",[VERSION]);
    }
  }catch(e){ console.error('changelog broadcast error',e.message); }
  app.listen(PORT,()=>console.log('StudyСПб v'+VERSION+' запущен на',PORT,'| напоминание в',REMIND_HOUR_MOSCOW,':00 МСК'));
})();
