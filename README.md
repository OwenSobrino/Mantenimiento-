# Sistema de gestión de mantenimiento de edificios (PostgreSQL)

## 1. Crear la base de datos gratis
Cree una cuenta en https://neon.tech (o Supabase / Render), cree un proyecto y copie la
"connection string" (empieza con postgresql://).

## 2. Ejecutar en su computador
1. Instale Node.js LTS desde https://nodejs.org
2. Copie `.env.example` como `.env` y pegue su connection string en DATABASE_URL.
3. En una terminal dentro de esta carpeta:
   npm install
   npm start
4. Abra http://localhost:3000

Las tablas y las cuentas de prueba se crean solas la primera vez.
Cuentas (clave 1234): admin@demo.com, usuario@demo.com, tecnico@demo.com

## 3. Publicar en Render
New > Web Service > conecte su repositorio de GitHub.
Build Command: npm install   |   Start Command: npm start
En "Environment" agregue DATABASE_URL con la misma connection string.
(No suba el archivo .env a GitHub.)

Estructura: server.js (API), schema.sql (tablas), public/index.html (interfaz).

## Instalar como app (PWA)
Con la página publicada en HTTPS (Render lo da) o en http://localhost:3000:
- Chrome / Edge (PC y Android): menú > "Instalar aplicación".
- iPhone (Safari): Compartir > "Añadir a pantalla de inicio".
La app necesita conexión: los datos siempre vienen del servidor.
