const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = (text, params) => pool.query(text, params);

// Стартовый словарь (слова, без предложений)
const SEED = [
 ["assume","предполагать / принимать на себя","assumed role = принятая роль"],
 ["since","с (момента) / поскольку","since 2020 = с 2020 года"],
 ["hand","передавать, вручать","hand in = сдать; hand out = раздать"],
 ["right away","сразу, немедленно","not right away = не сразу"],
 ["practical exercises","практические задания","в IT — практика, таски"],
 ["concise","лаконичный, краткий","короткий и по делу, без воды"],
 ["packed with","набитый под завязку","packed with details"],
 ["essential","ключевой, жизненно важный","сильнее, чем important"],
 ["encounter","сталкиваться, встречать","encounter problems"],
 ["discover","обнаруживать, открывать","открыть то, что было скрыто"],
 ["journey","путешествие, путь","метафора проф. пути"],
 ["further","дальнейший / продвигать","further your career (глагол!)"],
 ["nowadays","в наши дни","контраст с прошлым"],
 ["heavily rely","сильно полагаться","rely ON something"],
 ["crucial","решающий, крайне важный","сильнее important"],
 ["preventing","предотвращение","prevent FROM doing"],
 ["almost","почти, едва не","almost never (не nearly never)"],
 ["memorize","заучивать","активная зубрежка"],
 ["approximate","приблизительный","approximate structure"],
 ["landscape","ландшафт, экосистема","общая картина отрасли"],
 ["go through","проходить, разбирать","детально разобрать"],
 ["piece by piece","по кусочкам","тщательный разбор"],
 ["interconnected","взаимосвязанный","части влияют друг на друга"],
 ["client","клиент, клиентское устройство","запрашивает данные"],
 ["server","сервер","отдаёт данные клиенту"],
 ["cloud","облако","аренда мощностей"],
 ["blue team","синяя команда (защита)","внутренняя безопасность"],
 ["red team","красная команда (атака)","этичные хакеры"],
 ["purple team","фиолетовая команда","синергия Blue + Red"],
 ["adversary","противник, злоумышленник","проф. термин для хакера"],
 ["such as","такие как, например","формальнее like"],
 ["provide","предоставлять","provide WITH something"],
 ["various","различные","разнообразие типов"],
 ["perform","выполнять","perform tasks"],
 ["specific","конкретный","четко определенный"],
 ["might be","может быть","вероятность"],
 ["each other","друг с другом","для 2 объектов"],
 ["refers to","означает, относится к","фраза для определений"],
 ["responsible for","ответственный за","всегда с FOR"],
 ["internal","внутренний","internal security"],
 ["against","против","defend against attacks"],
 ["actual","реальный, фактический","НЕ «актуальный»!"],
 ["delve","углубляться","delve INTO the topic"],
 ["we'll","мы будем (we will)","в речи звучит как wheel"],
 ["into","в, внутрь","dive into = погрузиться"],
 ["penetration","проникновение","penetration testing = pentest"],
 ["vulnerabilities","уязвимости","сокр. vulns"],
 ["malicious","вредоносный","malicious software = malware"],
 ["exploit","эксплойт / использовать дыру","exploit a vulnerability"],
 ["measures","меры","security measures"],
 ["shift","сдвиг, переход","shift to cloud"],
 ["offer","предлагать","offers benefits"],
 ["benefits","преимущества, выгоды","плюсы, профиты"],
 ["like","как, например / нравиться","в тексте = such as"],
 ["convenience","удобство","convenient = удобный"],
 ["opportunities","возможности, шансы","не possibilities"],
 ["disrupt","подрывать, ломать уклад","disruptive technology"],
 ["significant","значительный","significant impact"],
 ["lead","вести / приводить к","lead to; a lead = зацепка"],
 ["treasure","сокровище, клад","метафора данных"],
 ["store","хранить","stored data; cloud storage"],
 ["castle","замок, крепость","метафора инфраструктуры"],
 ["drawbridge","разводной мост","метафора точки входа"],
 ["encryption","шифрование","от crypt = скрытый"],
 ["outsiders","посторонние, внешние","противоположность insiders"],
 ["weak spots","слабые места","синоним vulnerabilities"],
 ["expand","расширять, расти","expanding network"],
 ["attract","привлекать","attracts hackers"],
 ["constantly","постоянно","constantly under attack"],
 ["breach","взлом, утечка","data breach"],
 ["strengthen","укреплять","strengthen security"],
 ["grow","расти","as data grows"],
 ["must","должен, обязан","сильнее should"],
 ["enhance","улучшать, усиливать","формальнее improve"],
 ["fortress","крепость, твердыня","digital fortress"],
 ["importance","важность","of great importance"],
 ["necessity","необходимость","сильнее need"],
 ["stem from","происходить из","корениться в"],
 ["consequences","последствия","обычно негативные"],
 ["ramifications","разветвлённые последствия","цепная реакция"]
];

async function init(){
  const schema = fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8');
  await q(schema);
  const { rows } = await q('SELECT COUNT(*)::int AS n FROM words');
  if(rows[0].n === 0){
    for(const [en,ru,note] of SEED) await q('INSERT INTO words(en,ru,note) VALUES($1,$2,$3)',[en,ru,note]);
    console.log('Seeded', SEED.length, 'words');
  }
}

module.exports = { q, init };