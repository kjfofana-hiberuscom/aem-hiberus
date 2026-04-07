# mcp-aem-hiberus — AEM MCP Server

MCP Server para Adobe Experience Manager. 56 tools cubriendo sites, páginas, componentes, búsqueda, plantillas, publicación, workflows, content fragments, assets y experience fragments.

---

## Requisitos

- Node.js 18+
- AEM instancia corriendo (autor o publicación)

---

## Variables de entorno

| Variable | Descripción | Por defecto |
|---|---|---|
| `AEM_URL` | URL base de AEM | `http://localhost:4502` |
| `AEM_USER` | Usuario AEM | `admin` |
| `AEM_PASSWORD` | Contraseña AEM | `admin` |
| `AEM_READ_ONLY` | `"true"` para deshabilitar tools de escritura | `false` |
| `MCP_TRANSPORT` | `stdio` (default) o `http` | `stdio` |
| `PORT` | Puerto para modo HTTP | `3000` |

---

## Configuración en el cliente MCP

### Modo stdio (por defecto)

El proceso MCP se lanza directamente. Cada cliente tiene su propia instancia del proceso.

```json
"mcp-aem-hiberus": {
  "command": "node",
  "args": ["/home/korodjouma/AEM/AEM MCP/mcp-aem-hiberus/build/index.js"],
  "env": {
    "AEM_URL": "http://localhost:4502",
    "AEM_USER": "admin",
    "AEM_PASSWORD": "admin"
  }
}
```

### Modo HTTP (Streamable HTTP — multi-agente)

El servidor HTTP se arranca **una sola vez** con variables de entorno. Cada agente conecta por HTTP y recibe su propio `Mcp-Session-Id`. Las sesiones son aisladas entre sí.

**Arrancar el servidor HTTP:**

```bash
MCP_TRANSPORT=http PORT=3000 AEM_URL=http://localhost:4502 AEM_USER=admin AEM_PASSWORD=admin node /home/korodjouma/AEM/AEM MCP/mcp-aem-hiberus/build/index.js
```

```bash
MCP_TRANSPORT=http PORT=3000 AEM_URL=http://localhost:4502 AEM_USER=admin AEM_PASSWORD=admin node /home/korodjouma/AEM/AEM\ MCP/mcp-aem-hiberus/build/index.js
``

**Configuración en el cliente MCP (modo HTTP):**

```json
"mcp-aem-hiberus": {
  "url": "http://127.0.0.1:3000/mcp",
  "transport": "http"
}
```

> El servidor sólo acepta conexiones desde `127.0.0.1` (localhost). No se expone en interfaces externas.

#### Diferencias clave entre modos

| | stdio | http |
|---|---|---|
| Instancias del servidor | Una por agente | Una compartida |
| Arranque | El cliente lo gestiona | Manual (o systemd / PM2) |
| Aislamiento de sesión | Por proceso | Por `Mcp-Session-Id` |
| Multi-agente en paralelo | No (un proceso por agente) | Sí |
| Recomendado para | Un solo agente / desarrollo | Múltiples agentes en paralelo |

---

## Build

```bash
npm run build
```

Salida en `./build/`.

---

## Desarrollo con MCP Inspector

```bash
npx @modelcontextprotocol/inspector node build/index.js
```

---

## CRX Inspector Tools (4)

Tools para inspección profunda de componentes AEM: definiciones JCR, diálogos, modelos Sling y comparación de instancias.

| Tool | Descripción | Input principal | R/W |
|---|---|---|---|
| `getComponentDefinition` | Definición completa de un componente: metadatos JCR, campos de diálogo por tab, fuente HTL, Sling Models detectados y child templates. Resuelve la cadena `slingResourceSuperType` hasta 5 niveles. | `resourceType` | R |
| `listAppComponents` | Lista todos los nodos `cq:Component` bajo `/apps/{appName}/components` agrupados por `componentGroup`. Incluye flag `hasDialog`. | `appName` | R |
| `compareComponentInstances` | Diff profundo de dos instancias JCR de componente, ignorando propiedades volátiles (`jcr:uuid`, `jcr:created`, etc.). Útil para validar migraciones. Limita a 100 entradas de diff. | `referencePath`, `currentPath` | R |
| `getSlingModelInfo` | Obtiene metadatos de un Sling Model desde la consola Felix (`/system/console/status-slingmodels`): adaptables, interfaz adaptadora y binding de resourceType. Fallback a extracción desde `data-sly-use` en HTL si Felix no está disponible. | `resourceType` o `className` | R |
