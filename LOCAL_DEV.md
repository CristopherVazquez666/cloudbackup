# Desarrollo Local

Usa este flujo para trabajar sin empujar cambios a `main`.

Opcion recomendada en este equipo:

```bash
./scripts/dev-local.sh
```

Si en otro equipo si tienes Docker Compose disponible, tambien puedes usar:

```bash
docker compose -f docker-compose.dev.yml up --build
```

URLs locales:

- Admin: `http://localhost:3000/admin/`
- User preview: `http://localhost:3000/api/auth/dev/user-preview`
- Health: `http://localhost:3000/health`

Notas:

- El panel user real sigue esperando SSO. La URL `dev/user-preview` crea una sesion local de prueba y redirige a `/user/`.
- Los cambios en `src/public/` y `src/` se reflejan en el contenedor con recarga automatica por `nodemon`.
- Para detener el entorno:

```bash
./scripts/dev-local-stop.sh
```
