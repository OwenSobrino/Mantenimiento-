require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- Base de datos (PostgreSQL) ----------
if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL. Revise el README.'); process.exit(1); }
const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });

// Convierte ? en $1, $2... (formato de PostgreSQL)
const sql = s => { let n = 0; return s.replace(/\?/g, () => '$' + (++n)); };
const all = async (s, ...a) => (await pool.query(sql(s), a)).rows;
const one = async (s, ...a) => (await all(s, ...a))[0];
const run = (s, ...a) => pool.query(sql(s), a);

async function init() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  if (!(await one('SELECT COUNT(*)::int n FROM usuarios')).n) {
    const p = bcrypt.hashSync('1234', 10);
    for (const [n, c, r] of [['Ana Administradora', 'admin@demo.com', 'Administrador'], ['Ulises Usuario', 'usuario@demo.com', 'Usuario'], ['Tomás Técnico', 'tecnico@demo.com', 'Técnico']])
      await run('INSERT INTO usuarios(nombre,correo,rol,pass) VALUES(?,?,?,?)', n, c, r, p);
    await run('INSERT INTO equipos(nombre,tipo,ubic,serie,gar,vence) VALUES(?,?,?,?,?,?)', 'Ascensor Torre A', 'Ascensor', 'Torre A', 'ASC-100', 'Otis', '2027-03-01');
    await run('INSERT INTO equipos(nombre,tipo,ubic,serie,gar,vence) VALUES(?,?,?,?,?,?)', 'Aire acondicionado Sala 2', 'Climatización', 'Piso 2', 'AC-220', 'LG', '2026-01-15');
  }
}

// ---------- Utilidades ----------
const A = 'Administrador', T = 'Técnico';
const now = () => new Date().toLocaleString('es');
const pub = ({ id, nombre, correo, rol }) => ({ id, nombre, correo, rol });
const sessions = new Map();
const fail = m => { throw new Error(m); };

// h envuelve cada ruta: devuelve JSON y convierte errores en respuestas 400
const h = f => async (req, res) => {
  try { res.json((await f(req)) ?? { ok: true }); }
  catch (e) { res.status(400).json({ error: e.code === '23505' ? 'Ya existe un registro con esos datos (por ejemplo, ese correo).' : e.message }); }
};
const auth = async (req, res, next) => {
  try {
    const id = sessions.get(req.headers.authorization);
    const u = id && await one('SELECT * FROM usuarios WHERE id=?', id);
    if (!u) return res.status(401).json({ error: 'Sesión no válida' });
    req.u = u; next();
  } catch (e) { res.status(500).json({ error: e.message }); }
};
const admin = r => r.u.rol === A || fail('Solo el administrador puede hacer esto');

// ---------- App ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Autenticación (RF01-RF04)
app.post('/api/login', h(async r => {
  const u = await one('SELECT * FROM usuarios WHERE LOWER(correo)=?', String(r.body.correo || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(r.body.pass || '', u.pass)) fail('Correo o contraseña incorrectos');
  const token = crypto.randomUUID();
  sessions.set(token, u.id);
  return { token, user: pub(u) };
}));
app.post('/api/password', auth, h(async r => {
  const { a, n } = r.body;
  if (!bcrypt.compareSync(a || '', r.u.pass) || !n || n.length < 6) fail('La contraseña actual no coincide o la nueva tiene menos de 6 caracteres.');
  await run('UPDATE usuarios SET pass=? WHERE id=?', bcrypt.hashSync(n, 10), r.u.id);
}));

// Datos visibles según el rol (RF13)
app.get('/api/data', auth, h(async r => {
  const u = r.u, adm = u.rol === A;
  const [users, equipos, inc, mant, rep] = await Promise.all([
    all('SELECT id,nombre,correo,rol FROM usuarios ORDER BY id'),
    all('SELECT * FROM equipos ORDER BY id'),
    all('SELECT * FROM incidencias ORDER BY id'),
    all('SELECT * FROM mantenimientos ORDER BY id'),
    all('SELECT * FROM reparaciones ORDER BY id'),
  ]);
  return {
    users: users.map(x => adm || x.id === u.id ? x : { id: x.id, nombre: x.nombre, rol: x.rol }),
    equipos,
    inc: inc.filter(i => adm || i.por === u.id || i.tec === u.id),
    mant: mant.filter(m => adm || m.tec === u.id),
    rep: rep.filter(x => adm || x.tec === u.id),
  };
}));

// Usuarios y técnicos (RF05-RF08)
const ROLES = ['Usuario', 'Técnico', 'Administrador'];
app.post('/api/users', auth, h(async r => {
  admin(r); const b = r.body;
  const nombre = String(b.nombre || '').trim(), correo = String(b.correo || '').trim().toLowerCase();
  if (!nombre || !correo) fail('Nombre y correo son obligatorios');
  if (!ROLES.includes(b.rol)) fail('Rol no válido');
  if (String(b.pass || '').length < 6) fail('La contraseña debe tener al menos 6 caracteres');
  await run('INSERT INTO usuarios(nombre,correo,rol,pass) VALUES(?,?,?,?)', nombre, correo, b.rol, bcrypt.hashSync(b.pass, 10));
}));
app.patch('/api/users/:id', auth, h(async r => {
  const id = +r.params.id, b = r.body, adm = r.u.rol === A;
  if (!adm && id !== r.u.id) fail('No tiene permiso para esta acción');
  const cur = await one('SELECT * FROM usuarios WHERE id=?', id) || fail('No existe');
  const correo = b.correo ? String(b.correo).trim().toLowerCase() : cur.correo;
  const nombre = adm && b.nombre ? String(b.nombre).trim() : cur.nombre;
  const rol = adm && id !== r.u.id && ROLES.includes(b.rol) ? b.rol : cur.rol;
  let pass = cur.pass;
  if (b.pass !== undefined) { // el administrador asigna una nueva contraseña a otra cuenta
    if (!adm || id === r.u.id) fail('Use "Cambiar contraseña" en Mi cuenta');
    if (String(b.pass).length < 6) fail('La contraseña debe tener al menos 6 caracteres');
    pass = bcrypt.hashSync(b.pass, 10);
  }
  await run('UPDATE usuarios SET nombre=?, correo=?, rol=?, pass=? WHERE id=?', nombre, correo, rol, pass, id);
}));

// Incidencias (RF09-RF20)
app.post('/api/inc', auth, h(async r => {
  const b = r.body; // todos los roles pueden registrar (RF11)
  await run('INSERT INTO incidencias(titulo,"desc",ubic,eq,por,creada) VALUES(?,?,?,?,?,?)', b.titulo, b.desc, b.ubic, b.eq || null, r.u.id, now());
}));
app.patch('/api/inc/:id', auth, h(async r => {
  const { k, v } = r.body, id = +r.params.id, u = r.u;
  const i = await one('SELECT * FROM incidencias WHERE id=?', id) || fail('No existe');
  if (k === 'tec') {
    admin(r);
    if (v) await run("UPDATE incidencias SET tec=?, est='Asignada', asig=? WHERE id=?", +v, now(), id);
    else await run("UPDATE incidencias SET tec=NULL, est='Pendiente', asig=NULL WHERE id=?", id);
  } else if (k === 'crit' || k === 'prio') {
    admin(r); await run(`UPDATE incidencias SET ${k}=? WHERE id=?`, v, id);
  } else if (k === 'eq') {
    admin(r); await run('UPDATE incidencias SET eq=? WHERE id=?', +v || null, id);
  } else if (k === 'est') {
    if (u.rol !== T || i.tec !== u.id) fail('Solo el técnico asignado puede cambiar el estado');
    if (!['Asignada', 'En reparación', 'Solucionada'].includes(v)) fail('Estado no válido');
    await run('UPDATE incidencias SET est=? WHERE id=?', v, id);
  } else if (k === 'cal') {
    if (i.por !== u.id || i.est !== 'Cerrada') fail('No puede calificar esta incidencia');
    await run('UPDATE incidencias SET cal=? WHERE id=?', +v, id);
  } else fail('Campo no permitido');
}));
app.post('/api/inc/:id/confirmar', auth, h(async r => {
  const i = await one('SELECT * FROM incidencias WHERE id=?', +r.params.id) || fail('No existe');
  if (i.por !== r.u.id || i.est !== 'Solucionada') fail('No puede confirmar esta incidencia');
  await run("UPDATE incidencias SET conf=1, est='Cerrada' WHERE id=?", i.id);
}));
app.post('/api/merge', auth, h(async r => { // RF15
  admin(r);
  const a = await one('SELECT * FROM incidencias WHERE id=?', +r.body.a), b = await one('SELECT * FROM incidencias WHERE id=?', +r.body.b);
  if (!a || !b) fail('Incidencia no encontrada');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('UPDATE incidencias SET "desc"=$1 WHERE id=$2', [`${a.desc} | Fusionada INC-${b.id}: ${b.desc}`, a.id]);
    await c.query('UPDATE reparaciones SET inc=$1 WHERE inc=$2', [a.id, b.id]);
    await c.query('DELETE FROM incidencias WHERE id=$1', [b.id]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}));

// Equipos y garantías (RF21-RF27)
app.post('/api/equipos', auth, h(async r => {
  admin(r); const b = r.body;
  await run('INSERT INTO equipos(nombre,tipo,ubic,serie) VALUES(?,?,?,?)', b.nombre, b.tipo, b.ubic, b.serie);
}));
app.patch('/api/equipos/:id', auth, h(async r => {
  admin(r); await run('UPDATE equipos SET gar=?, vence=? WHERE id=?', r.body.gar, r.body.vence, +r.params.id);
}));

// Mantenimiento preventivo (RF28-RF29)
app.post('/api/mant', auth, h(async r => {
  admin(r); const b = r.body;
  await run('INSERT INTO mantenimientos(eq,tarea,fecha,tec) VALUES(?,?,?,?)', +b.eq, b.tarea, b.fecha, +b.tec);
}));
app.patch('/api/mant/:id', auth, h(async r => {
  const m = await one('SELECT * FROM mantenimientos WHERE id=?', +r.params.id) || fail('No existe');
  if (r.u.rol !== T || m.tec !== r.u.id) fail('Solo el técnico asignado puede registrar la ejecución');
  await run('UPDATE mantenimientos SET hecho=? WHERE id=?', r.body.hecho, m.id);
}));

// Reparaciones (RF30)
app.post('/api/rep', auth, h(async r => {
  const b = r.body, i = await one('SELECT * FROM incidencias WHERE id=?', +b.inc) || fail('No existe');
  if (r.u.rol !== T || i.tec !== r.u.id) fail('Solo el técnico asignado puede registrar la reparación');
  await run('INSERT INTO reparaciones(inc,tec,act,causa,mat,ini,fin,sol,obs) VALUES(?,?,?,?,?,?,?,?,?)', i.id, r.u.id, b.act, b.causa, b.mat, b.ini, b.fin, b.sol, b.obs);
}));

const port = process.env.PORT || 3000;
init().then(() => app.listen(port, () => console.log(`Servidor listo en http://localhost:${port}`)))
  .catch(e => { console.error('No se pudo conectar a la base de datos:', e.message); process.exit(1); });
