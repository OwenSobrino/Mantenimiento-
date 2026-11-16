CREATE TABLE IF NOT EXISTS usuarios(
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  correo TEXT NOT NULL UNIQUE,
  rol TEXT NOT NULL CHECK(rol IN ('Usuario','Técnico','Administrador')),
  pass TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS equipos(
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL, tipo TEXT, ubic TEXT, serie TEXT,
  gar TEXT DEFAULT '', vence TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS incidencias(
  id SERIAL PRIMARY KEY,
  titulo TEXT NOT NULL, "desc" TEXT, ubic TEXT,
  eq INTEGER REFERENCES equipos(id),
  crit TEXT DEFAULT 'Sin clasificar',
  prio TEXT DEFAULT 'Media',
  est TEXT DEFAULT 'Pendiente',
  por INTEGER NOT NULL REFERENCES usuarios(id),
  tec INTEGER REFERENCES usuarios(id),
  creada TEXT, asig TEXT,
  conf INTEGER DEFAULT 0,
  cal INTEGER
);
CREATE TABLE IF NOT EXISTS mantenimientos(
  id SERIAL PRIMARY KEY,
  eq INTEGER NOT NULL REFERENCES equipos(id),
  tarea TEXT NOT NULL, fecha TEXT,
  tec INTEGER REFERENCES usuarios(id),
  hecho TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS reparaciones(
  id SERIAL PRIMARY KEY,
  inc INTEGER NOT NULL REFERENCES incidencias(id),
  tec INTEGER NOT NULL REFERENCES usuarios(id),
  act TEXT, causa TEXT, mat TEXT, ini TEXT, fin TEXT, sol TEXT, obs TEXT
);
