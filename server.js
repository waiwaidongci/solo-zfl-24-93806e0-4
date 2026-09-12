import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "pigeons.json");
const port = Number(process.env.PORT || 3024);
const REMIND_DAYS = 30;

const seed = {
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-04-01", name: "新城疫", dueDate: "" }], transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  // 迁移：旧版疫苗记录只有 date/name，补上空的到期日字段
  let migrated = false;
  for (const pigeon of db.pigeons) {
    if (!Array.isArray(pigeon.vaccines)) { pigeon.vaccines = []; migrated = true; continue; }
    for (const vaccine of pigeon.vaccines) {
      if (!("dueDate" in vaccine)) { vaccine.dueDate = ""; migrated = true; }
    }
  }
  if (migrated) await writeFile(dbPath, JSON.stringify(db, null, 2));
  return db;
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求体不是合法的 JSON");
    error.code = "bad_json";
    throw error;
  }
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function relation(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  return { pigeon, father, mother, children };
}

// 严格校验 YYYY-MM-DD：格式、日历真实存在（拒绝 2026-02-30、2026-13-01）
function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [, y, m, d] = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const year = Number(y), month = Number(m), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = Date.UTC(year, month - 1, day);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  return utc;
}
const DAY_MS = 86400000;
function daysBetween(fromUtc, toUtc) { return Math.round((toUtc - fromUtc) / DAY_MS); }
function vaccineStatus(vaccine, todayUtc) {
  if (!vaccine.dueDate) return { status: "unknown", daysToDue: null, reminder: "未记录到期日" };
  const daysToDue = daysBetween(todayUtc, parseDate(vaccine.dueDate));
  if (daysToDue < 0) return { status: "expired", daysToDue, reminder: `已过期 ${-daysToDue} 天（${vaccine.dueDate} 到期）` };
  if (daysToDue === 0) return { status: "due_today", daysToDue, reminder: `今日到期（${vaccine.dueDate}），请尽快接种` };
  if (daysToDue <= REMIND_DAYS) return { status: "upcoming", daysToDue, reminder: `${daysToDue} 天后到期（${vaccine.dueDate}）` };
  return { status: "valid", daysToDue, reminder: `有效期内，${vaccine.dueDate} 到期` };
}
function latestVaccine(vaccines) {
  return vaccines.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0] || null;
}
function vaccineSummary(pigeon, todayUtc) {
  const latest = latestVaccine(pigeon.vaccines || []);
  const overdue = (pigeon.vaccines || []).filter(v => v.dueDate && parseDate(v.dueDate) < todayUtc).length;
  const upcoming = (pigeon.vaccines || []).filter(v => {
    if (!v.dueDate) return false;
    const diff = daysBetween(todayUtc, parseDate(v.dueDate));
    return diff >= 0 && diff <= REMIND_DAYS;
  }).length;
  let reminder = "暂无疫苗记录";
  if (latest) reminder = vaccineStatus(latest, todayUtc).reminder;
  return { latestVaccine: latest, overdue, upcoming, reminder };
}
function ledgerEntry(pigeon, vaccine, todayUtc) {
  const info = vaccineStatus(vaccine, todayUtc);
  return {
    ringNo: pigeon.ringNo,
    owner: pigeon.owner,
    color: pigeon.color,
    loft: pigeon.loft,
    name: vaccine.name,
    date: vaccine.date,
    dueDate: vaccine.dueDate,
    status: info.status,
    daysToDue: info.daysToDue,
    reminder: info.reminder
  };
}

const sharedCss = `
  :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --green:#357a4f; --amber:#9a6a1f; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
  header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
  h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
  form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
  label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
  button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
  a.linkbtn { display:inline-block; border-radius:6px; background:#eef3f7; color:var(--accent); padding:10px 13px; font-weight:700; text-decoration:none; border:1px solid var(--line); }
  .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
  .card { display:grid; gap:8px; } .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
  .section { margin-top:14px; } .relation { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; } .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; }
  .msg { margin-top:10px; font-size:13px; min-height:18px; } .msg.ok { color:var(--green); } .msg.err { color:var(--red); }
  .filters { display:grid; grid-template-columns:repeat(4,minmax(130px,1fr)) auto; gap:10px; align-items:end; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  th,td { text-align:left; padding:9px 11px; border-bottom:1px solid var(--line); font-size:14px; } th { background:#f4f7f9; font-size:13px; color:var(--muted); }
  tbody tr { cursor:pointer; } tbody tr:hover { background:#f6fafc; }
  .badge { display:inline-block; border-radius:999px; padding:2px 9px; font-size:12px; border:1px solid var(--line); }
  .badge.valid { color:var(--green); border-color:var(--green); } .badge.upcoming,.badge.due_today { color:var(--amber); border-color:var(--amber); }
  .badge.expired { color:var(--red); border-color:var(--red); } .badge.unknown { color:var(--muted); }
  .reminder.expired,.reminder.due_today { color:var(--red); font-weight:700; } .reminder.upcoming { color:var(--amber); }
  .detail-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; }
  @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} .filters{grid-template-columns:1fr 1fr;} .detail-grid{grid-template-columns:1fr;} }
`;

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽血统环号登记站</title>
  <style>${sharedCss}</style>
</head>
<body>
  <header><div><h1>赛鸽血统环号登记站</h1><div class="meta">档案、血统、转让和归巢成绩</div></div><div style="display:flex;gap:10px"><a class="linkbtn" href="/vaccines">疫苗台账</a><button id="reload">刷新</button></div></header>
  <main>
    <form id="form">
      <h2>创建鸽只档案</h2>
      <label>足环号</label><input name="ringNo" required>
      <label>鸽主</label><input name="owner" required>
      <label>父鸽足环号</label><input name="fatherRing">
      <label>母鸽足环号</label><input name="motherRing">
      <label>羽色</label><input name="color" required>
      <label>出生棚号</label><input name="loft" required>
      <button>保存档案</button>
      <div class="msg err" id="formMsg"></div>
    </form>
    <section>
      <div class="toolbar"><input id="search" placeholder="输入足环号查询血统"><button id="searchBtn">查询</button></div>
      <div class="panel" id="detail"></div>
      <div class="section grid" id="cards"></div>
    </section>
  </main>
  <script>
    const form = document.querySelector("#form");
    const cards = document.querySelector("#cards");
    const detail = document.querySelector("#detail");
    const search = document.querySelector("#search");
    let pigeons = [];
    const DAY = 86400000;
    function todayUTC(){ const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
    function esc(s){ return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;","'":"&#39;"}[c])); }
    function latestVaccine(p){ return (p.vaccines||[]).slice().sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:0)[0]||null; }
    function vaccineReminder(p){
      const v = latestVaccine(p);
      if (!v) return '<span class="meta">最近接种：暂无</span>';
      let note = "未记录到期日";
      if (v.dueDate){
        const days = Math.round((Date.parse(v.dueDate+"T00:00:00Z") - todayUTC())/DAY);
        if (days < 0) note = '已过期 '+(-days)+' 天';
        else if (days === 0) note = "今日到期";
        else if (days <= 30) note = days+' 天后到期';
        else note = "有效期内";
      }
      const cls = note.indexOf("过期")>=0 || note.indexOf("到期")>=0 ? "style='color:var(--red);font-weight:700'" : (note.indexOf("天后")>=0 ? "style='color:var(--amber)'" : "class='meta'");
      return '<span '+cls+'>最近接种：'+esc(v.name)+' '+esc(v.date)+' · '+esc(note)+(v.dueDate?'（'+esc(v.dueDate)+' 到期）':'')+'</span>';
    }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "请求失败");
      return data;
    }
    function renderCards() {
      cards.innerHTML = pigeons.map(p => '<article class="card"><h3>'+esc(p.ringNo)+'</h3><span class="pill">'+esc(p.owner)+'</span><div class="meta">'+esc(p.color)+' · '+esc(p.loft)+'</div><div>父：'+esc(p.fatherRing || "未登记")+'</div><div>母：'+esc(p.motherRing || "未登记")+'</div>'+vaccineReminder(p)+'<a class="linkbtn" style="text-align:center" href="/vaccines?ring='+encodeURIComponent(p.ringNo)+'">疫苗台账</a><label>录入转让</label><input data-to="'+esc(p.ringNo)+'" placeholder="新归属人"><button data-transfer="'+esc(p.ringNo)+'">保存转让</button><label>归巢成绩</label><input data-race="'+esc(p.ringNo)+'" placeholder="赛事/距离/名次，如200公里/200/6"><button data-score="'+esc(p.ringNo)+'">保存成绩</button></article>').join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+ringNo+'"]').value;
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to }) }); await load();
      });
      document.querySelectorAll("[data-score]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.score; const raw = document.querySelector('[data-race="'+ringNo+'"]').value.split("/");
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/races', { method:'POST', body: JSON.stringify({ event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0) }) }); await load();
      });
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、转让和成绩。</p>'; return; }
      const p = data.pigeon;
      detail.innerHTML = '<h2>'+esc(p.ringNo)+' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>'+esc(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+esc(p.owner)+' · '+esc(p.color)+'</div><div class="small"><b>母鸽</b><br>'+esc(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div><div><b>子代</b> '+esc(data.children.map(c => c.ringNo).join("、") || "暂无")+'</div><div class="meta">转让：'+esc(p.transfers.map(t => t.from+"→"+t.to).join(" / ") || "暂无")+'</div><div class="meta">归巢：'+esc(p.races.map(r => r.event+" 第"+r.rank+"名").join(" / ") || "暂无")+'</div><div style="margin-top:6px">'+vaccineReminder(p)+' <a href="/vaccines?ring='+encodeURIComponent(p.ringNo)+'">查看疫苗台账</a></div>';
    }
    async function load(){ pigeons = await api("/api/pigeons"); renderCards(); renderRelation(null); }
    document.querySelector("#searchBtn").onclick = async () => {
      try { renderRelation(await api('/api/pigeons/'+encodeURIComponent(search.value)+'/relation')); }
      catch (e) { detail.innerHTML = '<h2>血统查询</h2><p class="msg err">'+esc(e.message)+'</p>'; }
    };
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      const msg = document.querySelector("#formMsg");
      try {
        await api("/api/pigeons", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reset(); msg.textContent = ""; await load();
      } catch (e) { msg.textContent = e.message; }
    };
    load();
  </script>
</body>
</html>`;

const vaccinePage = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>疫苗台账 - 赛鸽血统环号登记站</title>
  <style>${sharedCss}</style>
</head>
<body>
  <header><div><h1>疫苗台账</h1><div class="meta">登记接种记录，按到期状态与日期查询，到期自动提醒</div></div><div style="display:flex;gap:10px"><a class="linkbtn" href="/">返回登记站</a><button id="reload">刷新</button></div></header>
  <main>
    <section>
      <form id="vaxForm" class="panel">
        <h2>登记疫苗接种</h2>
        <label>赛鸽足环号（仅已登记赛鸽）</label>
        <select name="ringNo" id="ringSelect" required></select>
        <label>疫苗名称</label>
        <input name="name" list="vaxNames" placeholder="如：新城疫疫苗" required>
        <datalist id="vaxNames">
          <option value="新城疫疫苗"><option value="腺病毒疫苗"><option value="鸽痘疫苗">
          <option value="沙门氏菌疫苗"><option value="巴拉米哥疫苗"><option value="禽流感疫苗">
        </datalist>
        <label>接种日期</label>
        <input name="date" type="date" required>
        <label>下次到期日（须晚于接种日期）</label>
        <input name="dueDate" type="date" required>
        <div style="margin-top:12px"><button type="submit">保存接种记录</button></div>
        <div class="msg" id="vaxMsg"></div>
      </form>
      <div class="panel section">
        <h2>到期规则</h2>
        <div class="meta">同一只鸽、同一种疫苗在有效期内不能重复登记；到期日当天计入“今日到期”，到期前 30 天起提醒。</div>
      </div>
    </section>
    <section>
      <form id="filterForm" class="panel">
        <h2>到期查询</h2>
        <div class="filters">
          <div><label>到期状态</label>
            <select name="status" id="fStatus">
              <option value="">全部</option>
              <option value="valid">有效期内</option>
              <option value="upcoming">30天内到期</option>
              <option value="due_today">今日到期</option>
              <option value="expired">已过期</option>
              <option value="unknown">无到期日（旧记录）</option>
            </select>
          </div>
          <div><label>截止日期（以此日判断到期）</label><input name="asOf" id="fAsOf" type="date"></div>
          <div><label>到期日范围 起</label><input name="dueAfter" id="fDueAfter" type="date"></div>
          <div><label>到期日范围 止</label><input name="dueBefore" id="fDueBefore" type="date"></div>
          <div><button type="submit">查询</button></div>
        </div>
      </form>
      <div class="panel section" id="detail">
        <h2>鸽只疫苗详情</h2>
        <p class="meta">点击右侧列表中的任一条记录，查看该鸽的完整接种台账与到期提醒。</p>
      </div>
      <h2 style="margin:16px 0 8px">接种记录 <span id="countLine" class="meta" style="font-size:13px;font-weight:400"></span></h2>
      <div class="panel" style="padding:0;overflow-x:auto">
        <table>
          <thead><tr><th>足环号</th><th>鸽主</th><th>疫苗</th><th>接种日期</th><th>下次到期日</th><th>状态</th><th>到期提醒</th></tr></thead>
          <tbody id="rows"><tr><td colspan="7" class="meta">加载中…</td></tr></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const vaxForm = document.querySelector("#vaxForm");
    const filterForm = document.querySelector("#filterForm");
    const rows = document.querySelector("#rows");
    const countLine = document.querySelector("#countLine");
    const detail = document.querySelector("#detail");
    const msg = document.querySelector("#vaxMsg");
    const ringSelect = document.querySelector("#ringSelect");
    const DAY = 86400000;
    let pigeons = [];
    const STATUS_TEXT = { valid:"有效期内", upcoming:"30天内到期", due_today:"今日到期", expired:"已过期", unknown:"无到期日" };
    function todayStr(){ const d = new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
    function esc(s){ return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;","'":"&#39;"}[c])); }
    function todayUTC(){ const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
    function baseUTC(){
      const v = document.querySelector("#fAsOf").value;
      if (v) { const t = Date.parse(v+"T00:00:00Z"); if (!Number.isNaN(t)) return t; }
      return todayUTC();
    }
    function statusOf(v, base){
      const ref = base === undefined ? baseUTC() : base;
      if (!v.dueDate) return "unknown";
      const days = Math.round((Date.parse(v.dueDate+"T00:00:00Z") - ref)/DAY);
      if (days < 0) return "expired";
      if (days === 0) return "due_today";
      if (days <= 30) return "upcoming";
      return "valid";
    }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "请求失败");
      return data;
    }
    function renderRows(entries) {
      if (!entries.length) { rows.innerHTML = '<tr><td colspan="7" class="meta">没有符合条件的记录</td></tr>'; return; }
      rows.innerHTML = entries.map(e =>
        '<tr data-ring="'+esc(e.ringNo)+'"><td>'+esc(e.ringNo)+'</td><td>'+esc(e.owner)+'</td><td>'+esc(e.name)+'</td><td>'+esc(e.date)+'</td><td>'+(e.dueDate?esc(e.dueDate):'<span class="meta">未记录</span>')+'</td><td><span class="badge '+e.status+'">'+STATUS_TEXT[e.status]+'</span></td><td class="reminder '+e.status+'">'+esc(e.reminder)+'</td></tr>'
      ).join("");
      rows.querySelectorAll("tr[data-ring]").forEach(tr => tr.onclick = () => showDetail(tr.dataset.ring));
    }
    async function query() {
      const params = new URLSearchParams(new FormData(filterForm));
      [...params.keys()].forEach(k => { if (!params.get(k)) params.delete(k); });
      try {
        const data = await api("/api/vaccines?" + params.toString());
        renderRows(data.entries);
        countLine.textContent = "共 " + data.count + " 条（状态判定日：" + data.asOf + "）";
      } catch (err) {
        renderRows([]);
        countLine.textContent = "";
        rows.innerHTML = '<tr><td colspan="7" class="reminder expired">查询失败：'+esc(err.message)+'</td></tr>';
      }
    }
    async function showDetail(ringNo) {
      try {
        const data = await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/vaccines');
        renderDetail(data);
      } catch (err) {
        detail.innerHTML = '<h2>鸽只疫苗详情</h2><p class="msg err">'+esc(err.message)+'</p>';
      }
    }
    function renderDetail(data) {
      const p = data.pigeon;
      const summary = data.summary;
      const base = baseUTC();
      const baseDateStr = new Date(base).toISOString().slice(0, 10);
      const refVaccines = data.vaccines.map(v => ({ ...v, st: statusOf(v, base) }));
      const overdue = refVaccines.filter(v => v.st === "expired").length;
      const upcoming = refVaccines.filter(v => v.st === "due_today" || v.st === "upcoming").length;
      const alerts = [];
      if (overdue) alerts.push('<span class="badge expired">'+overdue+' 项已过期</span>');
      if (upcoming) alerts.push('<span class="badge upcoming">'+upcoming+' 项30天内到期</span>');
      const latest = summary.latestVaccine;
      detail.innerHTML =
        '<h2>'+esc(p.ringNo)+' 疫苗详情</h2>' +
        '<div class="meta">'+esc(p.owner)+' · '+esc(p.color)+' · '+esc(p.loft)+'（状态判定日：'+baseDateStr+'）</div>' +
        '<div class="detail-grid section"><div class="small"><b>最近接种</b><br>'+(latest ? esc(latest.name)+'　'+esc(latest.date) : "暂无记录")+'</div>' +
        '<div class="small"><b>到期提醒</b><br>'+(alerts.length ? alerts.join(" ") : esc(summary.reminder))+'</div></div>' +
        '<table class="section" style="width:100%"><thead><tr><th>疫苗</th><th>接种日期</th><th>下次到期日</th><th>状态</th><th>提醒</th></tr></thead><tbody>' +
        refVaccines.map(v => {
          return '<tr style="cursor:default"><td>'+esc(v.name)+'</td><td>'+esc(v.date)+'</td><td>'+(v.dueDate?esc(v.dueDate):'<span class="meta">未记录</span>')+'</td><td><span class="badge '+v.st+'">'+STATUS_TEXT[v.st]+'</span></td><td class="reminder '+v.st+'">'+esc(reminderText(v, v.st, base))+'</td></tr>';
        }).join("") +
        '</tbody></table>';
    }
    function reminderText(v, st, base){
      const ref = base === undefined ? todayUTC() : base;
      if (st === "unknown") return "未记录到期日";
      const days = Math.round((Date.parse(v.dueDate+"T00:00:00Z") - ref)/DAY);
      if (st === "expired") return "已过期 "+(-days)+" 天（"+v.dueDate+" 到期）";
      if (st === "due_today") return "今日到期（"+v.dueDate+"），请尽快接种";
      if (st === "upcoming") return days+" 天后到期（"+v.dueDate+"）";
      return "有效期内，"+v.dueDate+" 到期";
    }
    async function init() {
      pigeons = await api("/api/pigeons");
      ringSelect.innerHTML = '<option value="">请选择足环号…</option>' + pigeons.map(p => '<option value="'+esc(p.ringNo)+'">'+esc(p.ringNo)+'（'+esc(p.owner)+'）</option>').join("");
      document.querySelector('input[name="date"]').value = todayStr();
      const params = new URLSearchParams(location.search);
      if (params.get("ring")) { ringSelect.value = params.get("ring"); showDetail(params.get("ring")); }
      query();
    }
    filterForm.onsubmit = e => { e.preventDefault(); query(); };
    document.querySelector("#reload").onclick = () => { query(); const ring = ringSelect.value; if (ring) showDetail(ring); };
    vaxForm.onsubmit = async e => {
      e.preventDefault();
      msg.className = "msg";
      const payload = Object.fromEntries(new FormData(vaxForm).entries());
      try {
        await api('/api/pigeons/'+encodeURIComponent(payload.ringNo)+'/vaccines', { method:"POST", body: JSON.stringify(payload) });
        msg.className = "msg ok";
        msg.textContent = "已登记："+payload.ringNo+" "+payload.name+"，到期日 "+payload.dueDate;
        vaxForm.reset();
        document.querySelector('input[name="date"]').value = todayStr();
        ringSelect.value = payload.ringNo;
        await query(); await showDetail(payload.ringNo);
        pigeons = await api("/api/pigeons");
      } catch (err) {
        msg.className = "msg err";
        msg.textContent = err.message;
      }
    };
    init();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    const todayUtc = (() => { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); })();

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/vaccines") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(vaccinePage);
    }
    if (req.method === "GET" && url.pathname === "/api/pigeons") {
      return sendJson(res, 200, db.pigeons.map(p => ({ ...p, vaccineSummary: vaccineSummary(p, todayUtc) })));
    }
    if (req.method === "POST" && url.pathname === "/api/pigeons") {
      const input = await body(req);
      if (!input.ringNo || !String(input.ringNo).trim()) return sendJson(res, 400, { error: "足环号不能为空" });
      if (db.pigeons.some(item => item.ringNo === input.ringNo)) return sendJson(res, 409, { error: "ring_exists", message: "该足环号已登记，不能重复建档" });
      const pigeon = { ...input, vaccines: [], transfers: [], races: [] };
      db.pigeons.unshift(pigeon);
      await saveDb(db);
      return sendJson(res, 201, pigeon);
    }

    // 疫苗台账：全量/筛选查询
    if (req.method === "GET" && url.pathname === "/api/vaccines") {
      const q = url.searchParams;
      const asOfRaw = q.get("asOf") || null;
      const asOfUtc = asOfRaw === null ? todayUtc : parseDate(asOfRaw);
      if (asOfRaw !== null && asOfUtc === null) return sendJson(res, 400, { error: "invalid_date", message: `截止日期无效：“${asOfRaw}”，需为 YYYY-MM-DD 真实日期` });
      const dueAfterRaw = q.get("dueAfter");
      const dueBeforeRaw = q.get("dueBefore");
      if (dueAfterRaw !== null && parseDate(dueAfterRaw) === null) return sendJson(res, 400, { error: "invalid_date", message: `到期范围起始日无效：“${dueAfterRaw}”，需为 YYYY-MM-DD 真实日期` });
      if (dueBeforeRaw !== null && parseDate(dueBeforeRaw) === null) return sendJson(res, 400, { error: "invalid_date", message: `到期范围截止日无效：“${dueBeforeRaw}”，需为 YYYY-MM-DD 真实日期` });
      if (dueAfterRaw && dueBeforeRaw && parseDate(dueAfterRaw) > parseDate(dueBeforeRaw)) {
        return sendJson(res, 400, { error: "invalid_range", message: "到期日范围起始日不能晚于截止日" });
      }
      const status = q.get("status") || "";
      const allowed = ["", "valid", "upcoming", "due_today", "expired", "unknown"];
      if (!allowed.includes(status)) return sendJson(res, 400, { error: "invalid_status", message: `到期状态无效：“${status}”` });
      const ringNo = q.get("ringNo") || "";
      if (ringNo && !db.pigeons.some(p => p.ringNo === ringNo)) return sendJson(res, 404, { error: "pigeon_not_found", message: `未找到足环号为“${ringNo}”的赛鸽` });

      let entries = [];
      for (const pigeon of db.pigeons) {
        if (ringNo && pigeon.ringNo !== ringNo) continue;
        for (const vaccine of pigeon.vaccines || []) {
          const entry = ledgerEntry(pigeon, vaccine, asOfUtc);
          if (status && entry.status !== status) continue;
          if (dueAfterRaw && (!entry.dueDate || parseDate(entry.dueDate) < parseDate(dueAfterRaw))) continue;
          if (dueBeforeRaw && (!entry.dueDate || parseDate(entry.dueDate) > parseDate(dueBeforeRaw))) continue;
          entries.push(entry);
        }
      }
      // 最需要处理的排最前：已过期 → 今日到期 → 即将到期，再按到期日、足环号
      const order = { expired: 0, due_today: 1, upcoming: 2, valid: 3, unknown: 4 };
      entries.sort((a, b) => order[a.status] - order[b.status] || (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || a.ringNo.localeCompare(b.ringNo) || b.date.localeCompare(a.date));
      return sendJson(res, 200, { asOf: new Date(asOfUtc).toISOString().slice(0, 10), count: entries.length, entries });
    }

    const relationMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const data = relation(db, decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found", message: "未找到该足环号的赛鸽" });
    }

    // 鸽只疫苗详情
    const vaccineListMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/vaccines$/);
    if (vaccineListMatch && req.method === "GET") {
      const pigeon = db.pigeons.find(item => item.ringNo === decodeURIComponent(vaccineListMatch[1]));
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found", message: "未找到该足环号的赛鸽" });
      const vaccines = (pigeon.vaccines || []).map(v => ({ ...v, ...vaccineStatus(v, todayUtc) }))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      return sendJson(res, 200, { pigeon, summary: vaccineSummary(pigeon, todayUtc), vaccines });
    }

    const actionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const pigeon = db.pigeons.find(item => item.ringNo === decodeURIComponent(actionMatch[1]));
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found", message: "疫苗（或记录）只能挂在已登记的赛鸽上，未找到该足环号" });
      const input = await body(req);
      if (actionMatch[2] === "transfers") {
        if (!input.to || !String(input.to).trim()) return sendJson(res, 400, { error: "invalid_to", message: "新归属人不能为空" });
        const transfer = { date: input.date || new Date().toISOString().slice(0, 10), from: pigeon.owner, to: input.to };
        pigeon.owner = input.to;
        pigeon.transfers.push(transfer);
      }
      if (actionMatch[2] === "races") pigeon.races.push({ date: input.date || new Date().toISOString().slice(0, 10), event: input.event, distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0) });
      if (actionMatch[2] === "vaccines") {
        // 字段校验
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (!name) return sendJson(res, 400, { error: "invalid_name", message: "疫苗名称不能为空" });
        const dateUtc = parseDate(input.date);
        if (dateUtc === null) return sendJson(res, 400, { error: "invalid_date", message: `接种日期无效：“${input.date ?? ""}”，需为 YYYY-MM-DD 格式的真实日期` });
        const dueUtc = parseDate(input.dueDate);
        if (dueUtc === null) return sendJson(res, 400, { error: "invalid_date", message: `下次到期日无效：“${input.dueDate ?? ""}”，需为 YYYY-MM-DD 格式的真实日期` });
        if (dueUtc < dateUtc) return sendJson(res, 400, { error: "invalid_range", message: `下次到期日（${input.dueDate}）不能早于接种日期（${input.date}）` });
        const dateStr = input.date;
        const dueStr = input.dueDate;
        // 同一只鸽、同一种疫苗（同名）在有效期内不能重复登记：新接种日落入任一未到期的同名疫苗有效期即拦截
        const conflict = (pigeon.vaccines || []).find(v =>
          v.name.trim().toLowerCase() === name.toLowerCase() &&
          v.dueDate && parseDate(v.dueDate) !== null &&
          dateUtc >= parseDate(v.date) && dateUtc <= parseDate(v.dueDate)
        );
        if (conflict) {
          return sendJson(res, 409, {
            error: "vaccine_active",
            message: `该鸽已在有效期内接种过“${conflict.name}”（${conflict.date} 接种，${conflict.dueDate} 到期），到期前不能重复登记；可在到期日之后再登记新一针。`
          });
        }
        pigeon.vaccines.push({ date: dateStr, name, dueDate: dueStr });
      }
      await saveDb(db);
      return sendJson(res, 201, pigeon);
    }
    sendJson(res, 404, { error: "not_found", message: "接口或页面不存在" });
  } catch (error) {
    if (error.code === "bad_json") return sendJson(res, 400, { error: "bad_json", message: error.message });
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
