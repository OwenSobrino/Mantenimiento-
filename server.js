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
    for (const [n, c, r, esp, ubi] of [
      ['Ana Administradora', 'admin@demo.com', 'Administrador', null, null],
      ['Ulises Usuario', 'usuario@demo.com', 'Usuario', null, 'Torre A - Apto 101'],
      ['Tomás Técnico', 'tecnico@demo.com', 'Técnico', 'Electricidad', null]])
      await run('INSERT INTO usuarios(nombre,correo,rol,pass,especializacion,ubicacion) VALUES(?,?,?,?,?,?)', n, c, r, p, esp, ubi);
    await run('INSERT INTO equipos(nombre,tipo,ubic,serie,gar,vence) VALUES(?,?,?,?,?,?)', 'Ascensor Torre A', 'Ascensor', 'Torre A', 'ASC-100', 'Otis', '2027-03-01');
    await run('INSERT INTO equipos(nombre,tipo,ubic,serie,gar,vence) VALUES(?,?,?,?,?,?)', 'Aire acondicionado Sala 2', 'Climatización', 'Piso 2', 'AC-220', 'LG', '2026-01-15');
  }
}

// ---------- Utilidades ----------
const A = 'Administrador', T = 'Técnico', ROLES = ['Usuario', 'Técnico', 'Administrador'], PRIO = ['Baja', 'Media', 'Alta', 'Urgente'];
const now = () => new Date().toLocaleString('es');
const pub = ({ id, nombre, correo, rol }) => ({ id, nombre, correo, rol });
const sessions = new Map();
const fail = m => { throw new Error(m); };
const txt = v => String(v ?? '').trim();

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
  const u = await one('SELECT * FROM usuarios WHERE LOWER(correo)=?', txt(r.body.correo).toLowerCase());
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

// Datos: TODAS las incidencias y comentarios son visibles para todos los roles
app.get('/api/data', auth, h(async r => {
  const u = r.u, adm = u.rol === A;
  const [users, equipos, inc, com, mant, rep] = await Promise.all([
    all('SELECT id,nombre,correo,rol,especializacion,ubicacion FROM usuarios ORDER BY id'),
    all('SELECT * FROM equipos ORDER BY id'),
    all('SELECT * FROM incidencias ORDER BY id'),
    all('SELECT * FROM comentarios ORDER BY id'),
    all('SELECT * FROM mantenimientos ORDER BY id'),
    all('SELECT * FROM reparaciones ORDER BY id'),
  ]);
  return {
    users: users.map(x => adm || x.id === u.id ? x : { id: x.id, nombre: x.nombre, rol: x.rol, especializacion: x.especializacion, ubicacion: x.ubicacion }),
    equipos, inc, com,
    mant: mant.filter(m => adm || m.tec === u.id),
    rep: rep.filter(x => adm || x.tec === u.id),
  };
}));

// Usuarios y técnicos (RF05-RF08). Solo el administrador registra, actualiza y elimina cuentas.
app.post('/api/users', auth, h(async r => {
  admin(r); const b = r.body;
  const nombre = txt(b.nombre), correo = txt(b.correo).toLowerCase(), esp = txt(b.especializacion), ubi = txt(b.ubicacion);
  if (!nombre || !correo) fail('Nombre y correo son obligatorios');
  if (!ROLES.includes(b.rol)) fail('Rol no válido');
  if (b.rol === T && !esp) fail('La especialización es obligatoria para los técnicos');
  if (b.rol === 'Usuario' && !ubi) fail('La ubicación del inmueble es obligatoria para los usuarios');
  if (String(b.pass || '').length < 6) fail('La contraseña debe tener al menos 6 caracteres');
  await run('INSERT INTO usuarios(nombre,correo,rol,pass,especializacion,ubicacion) VALUES(?,?,?,?,?,?)', nombre, correo, b.rol, bcrypt.hashSync(b.pass, 10), b.rol === T ? esp : null, b.rol === 'Usuario' ? ubi : null);
}));
app.patch('/api/users/:id', auth, h(async r => {
  const id = +r.params.id, b = r.body, adm = r.u.rol === A;
  if (!adm && id !== r.u.id) fail('No tiene permiso para esta acción');
  const cur = await one('SELECT * FROM usuarios WHERE id=?', id) || fail('No existe');
  const correo = b.correo ? txt(b.correo).toLowerCase() : cur.correo;
  const nombre = adm && b.nombre ? txt(b.nombre) : cur.nombre;
  const rol = adm && id !== r.u.id && ROLES.includes(b.rol) ? b.rol : cur.rol;
  const esp = adm && b.especializacion !== undefined ? txt(b.especializacion) : cur.especializacion;
  const ubi = adm && b.ubicacion !== undefined ? txt(b.ubicacion) : cur.ubicacion;
  if (adm && rol === T && !esp) fail('La especialización es obligatoria para los técnicos');
  if (adm && rol === 'Usuario' && !ubi) fail('La ubicación del inmueble es obligatoria para los usuarios');
  let pass = cur.pass;
  if (b.pass !== undefined) { // el administrador asigna una nueva contraseña a otra cuenta
    if (!adm || id === r.u.id) fail('Use "Cambiar contraseña" en Mi cuenta');
    if (String(b.pass).length < 6) fail('La contraseña debe tener al menos 6 caracteres');
    pass = bcrypt.hashSync(b.pass, 10);
  }
  await run('UPDATE usuarios SET nombre=?, correo=?, rol=?, pass=?, especializacion=?, ubicacion=? WHERE id=?',
    nombre, correo, rol, pass, rol === T ? esp : null, rol === 'Usuario' ? ubi : null, id);
}));
app.delete('/api/users/:id', auth, h(async r => {
  admin(r); const id = +r.params.id;
  if (id === r.u.id) fail('No puede eliminar su propia cuenta');
  const u = await one('SELECT * FROM usuarios WHERE id=?', id) || fail('No existe');
  const n = await one('SELECT (SELECT COUNT(*) FROM incidencias WHERE por=?)::int a, (SELECT COUNT(*) FROM reparaciones WHERE tec=?)::int b, (SELECT COUNT(*) FROM comentarios WHERE autor=?)::int c', id, id, id);
  if (n.a || n.b || n.c) fail(`No se puede eliminar a ${u.nombre} porque tiene incidencias, reparaciones o comentarios registrados. Se conservan para mantener el historial.`);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("UPDATE incidencias SET tec=NULL, est='Pendiente', asig=NULL WHERE tec=$1 AND est IN ('Asignada','En reparación')", [id]);
    await c.query('UPDATE incidencias SET tec=NULL WHERE tec=$1', [id]);
    await c.query('UPDATE mantenimientos SET tec=NULL WHERE tec=$1', [id]);
    await c.query('DELETE FROM usuarios WHERE id=$1', [id]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}));

// Incidencias (RF09-RF20). Solo la prioridad clasifica la incidencia.
app.post('/api/inc', auth, h(async r => {
  const b = r.body; // todos los roles pueden registrar (RF11)
  if (!txt(b.titulo) || !txt(b.desc) || !txt(b.ubic)) fail('Título, descripción y ubicación son obligatorios');
  await run('INSERT INTO incidencias(titulo,"desc",ubic,eq,por,creada) VALUES(?,?,?,?,?,?)', txt(b.titulo), txt(b.desc), txt(b.ubic), b.eq || null, r.u.id, now());
}));
app.patch('/api/inc/:id', auth, h(async r => {
  const { k, v } = r.body, id = +r.params.id, u = r.u;
  const i = await one('SELECT * FROM incidencias WHERE id=?', id) || fail('No existe');
  if (k === 'tec') {
    admin(r);
    if (v) await run("UPDATE incidencias SET tec=?, est='Asignada', asig=? WHERE id=?", +v, now(), id);
    else await run("UPDATE incidencias SET tec=NULL, est='Pendiente', asig=NULL WHERE id=?", id);
  } else if (k === 'prio') {
    admin(r); if (!PRIO.includes(v)) fail('Prioridad no válida');
    await run('UPDATE incidencias SET prio=? WHERE id=?', v, id);
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

// Comentarios: cualquier rol puede comentar cualquier incidencia
app.post('/api/inc/:id/comentarios', auth, h(async r => {
  const i = await one('SELECT id FROM incidencias WHERE id=?', +r.params.id) || fail('No existe');
  const t = txt(r.body.texto);
  if (!t) fail('Escriba un comentario');
  if (t.length > 1000) fail('El comentario no puede pasar de 1000 caracteres');
  await run('INSERT INTO comentarios(inc,autor,texto,creado) VALUES(?,?,?,?)', i.id, r.u.id, t, now());
}));

// Fusionar (RF15): el administrador elige libremente cuáles incidencias unir y en cuál se conservan
app.post('/api/merge', auth, h(async r => {
  admin(r);
  const pid = +r.body.principal;
  const ids = [...new Set((r.body.ids || []).map(Number))].filter(x => x && x !== pid);
  if (!pid || !ids.length) fail('Seleccione al menos dos incidencias y marque cuál se conserva');
  const P = await one('SELECT * FROM incidencias WHERE id=?', pid) || fail('La incidencia principal no existe');
  const others = await all('SELECT * FROM incidencias WHERE id = ANY(?) ORDER BY id', ids);
  if (others.length !== ids.length) fail('Alguna incidencia seleccionada no existe');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let desc = P.desc || '';
    for (const o of others) {
      desc += ` | Fusionada INC-${o.id}: ${o.desc}`;
      await c.query('UPDATE reparaciones SET inc=$1 WHERE inc=$2', [pid, o.id]);
      await c.query('UPDATE comentarios SET inc=$1 WHERE inc=$2', [pid, o.id]);
      await c.query('INSERT INTO comentarios(inc,autor,texto,creado) VALUES($1,$2,$3,$4)', [pid, r.u.id, `Se fusionó INC-${o.id} («${o.titulo}») en esta incidencia.`, now()]);
      await c.query('DELETE FROM incidencias WHERE id=$1', [o.id]);
    }
    await c.query('UPDATE incidencias SET "desc"=$1 WHERE id=$2', [desc, pid]);
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
