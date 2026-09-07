# coriotlab-backend

Backend de consulta en lenguaje natural + interfaz web para la base de
errores de CORIOTLAB (Sistemas de Control y Robótica, ITM Medellín).

Repo hermano de datos: [`coriotlab-registro-errores`](https://github.com/CORIOTLAB/coriotlab-registro-errores)
(ahí es donde se registran los errores como GitHub Issues).

**Sitio en producción:** https://coriotlab-backend.vercel.app/

## Índice

- [Qué hace este proyecto](#qué-hace-este-proyecto)
- [Arquitectura](#arquitectura)
- [Estructura del repo](#estructura-del-repo)
- [Variables de entorno](#variables-de-entorno)
- [Cómo desplegar](#cómo-desplegar)
- [Cómo probar localmente](#cómo-probar-localmente)
- [Decisiones de diseño y por qué](#decisiones-de-diseño-y-por-qué)
- [Deuda técnica conocida](#deuda-técnica-conocida)
- [Troubleshooting](#troubleshooting)

## Qué hace este proyecto

Permite que cualquier persona del equipo escriba una pregunta en
lenguaje natural (ej. *"el motor no gira aunque el driver está
encendido"*) y reciba una respuesta basada en los errores reales que
otros ya registraron — sin tener que adivinar las palabras exactas que
usó quien reportó el error originalmente.

## Arquitectura

```
Usuario escribe una pregunta en index.html
         │
         ▼
POST /api/ask  (función serverless en Vercel, api/ask.js)
         │
         ├─► 1. Descarga data/index.json desde el repo de datos
         │      (vía API de contenido de GitHub, autenticado)
         │
         ├─► 2. Genera el embedding de la pregunta con
         │      Xenova/paraphrase-multilingual-MiniLM-L12-v2
         │      (Transformers.js — ejecuta en Node, sin servidor propio)
         │
         ├─► 3. Calcula similitud coseno contra cada issue del índice,
         │      filtra por umbral mínimo (0.3) y toma los 4 más relevantes
         │
         └─► 4. Le pasa esos issues como contexto a un modelo de Groq
                (openai/gpt-oss-120b) con instrucciones estrictas de
                no inventar nada fuera de lo que dice el issue

         ▼
Respuesta + fuentes citadas, mostradas en index.html
```

**Por qué el modelo de embeddings corre en el backend mismo (no en un
servidor dedicado):** el lab no tiene un servidor disponible para esto
(ver historial de decisiones del proyecto), así que todo el sistema
está diseñado para funcionar sobre capas gratuitas de servicios en la
nube, sin infraestructura propia que mantener.

## Estructura del repo

```
├── api/
│   └── ask.js              # Función serverless: toda la lógica de búsqueda + IA
├── index.html              # Frontend: interfaz de consulta (HTML+CSS+JS, sin build)
├── assets/                 # Logos del manual de marca de CORIOTLAB
├── package.json            # Dependencia: @xenova/transformers
├── vercel.json             # Configuración: maxDuration=60s para la función
└── NOTA-DEUDA-TECNICA-FORK.md  # Ver sección de deuda técnica más abajo
```

No hay paso de build — Vercel sirve `index.html` y `assets/` como
sitio estático, y `api/ask.js` como función serverless, automáticamente.

## Variables de entorno

Configurar en Vercel → Settings → Environment Variables (nunca en el
código ni en el repo):

| Variable | Qué es | Dónde conseguirla |
|---|---|---|
| `GROQ_API_KEY` | API key del modelo de lenguaje | console.groq.com (cuenta gratuita) |
| `GH_REPO` | Repo de datos, formato `owner/repo` | Valor fijo: `CORIOTLAB/coriotlab-registro-errores` |
| `GH_READ_TOKEN` | Token de GitHub con lectura del repo de datos | GitHub → Settings → Developer settings → Fine-grained tokens (permiso "Contents: Read-only" sobre `coriotlab-registro-errores`) |

## Cómo desplegar

Cualquier push a la rama `main` dispara un redeploy automático en
Vercel. **Importante:** por la situación descrita en
[deuda técnica](#deuda-técnica-conocida), hay que subir a **dos
remotos**:

```bash
git push origin main   # CORIOTLAB/coriotlab-backend (repo original)
git push fork main     # santiagocano298366/coriotlab-backend (el que Vercel realmente despliega)
```

Verificar cuál repo está conectado a Vercel en:
`vercel.com/<tu-proyecto>/settings/git`

## Cómo probar localmente

Este proyecto no tiene un modo "dev" configurado (se construyó
iterando directo contra Vercel por la naturaleza de sus dependencias
de red). Para probar cambios:

1. Sube el cambio a ambos remotos.
2. Espera el redeploy (Vercel → pestaña Deployments).
3. Prueba el endpoint básico primero:
   ```bash
   curl https://coriotlab-backend.vercel.app/api/ask
   # Debe responder: {"status":"ok","message":"..."}
   ```
4. Prueba una pregunta real:
   ```powershell
   $body = @{ question = "tu pregunta de prueba" } | ConvertTo-Json
   Invoke-RestMethod -Uri "https://coriotlab-backend.vercel.app/api/ask" -Method Post -Body $body -ContentType "application/json"
   ```

## Decisiones de diseño y por qué

- **Groq como proveedor del modelo de lenguaje:** confirmado (agosto
  2026) que no entrena modelos con los datos enviados por defecto, en
  ningún plan — importante porque los issues contienen código y
  configuraciones internas del lab. Gemini, la alternativa evaluada,
  sí usa el contenido para entrenar en su nivel gratuito.
- **Modelo `openai/gpt-oss-120b`:** el modelo original planeado
  (`llama-3.3-70b-versatile`) fue deprecado por Groq en junio de 2026.
  Si este modelo también se deprecara en el futuro, revisar
  `console.groq.com/docs/models` y actualizar la constante
  `GROQ_MODEL` en `api/ask.js`.
- **`temperature: 0` y `max_tokens: 500`:** se detectó que el modelo
  "inventaba" pasos de diagnóstico genéricos no presentes en los
  issues reales cuando tenía más libertad. Estos parámetros, junto con
  un system prompt estricto, reducen ese riesgo.
- **Instrucción explícita de "no usar Markdown":** el frontend muestra
  la respuesta como texto plano (no interpreta `**negrita**` ni
  `[links](url)`), así que el modelo debe responder en texto plano
  desde el origen.
- **Embeddings con Transformers.js en vez de una API externa:** debe
  ser exactamente el mismo modelo usado en la indexación
  (`paraphrase-multilingual-MiniLM-L12-v2`) para que los vectores sean
  comparables — no se puede mezclar modelos de embedding distintos
  entre indexación y consulta.

## Deuda técnica conocida

**El despliegue en Vercel corre desde un fork personal
(`santiagocano298366/coriotlab-backend`), no desde el repo original de
la organización (`CORIOTLAB/coriotlab-backend`).** Esto pasó porque la
cuenta usada para conectar Vercel no tenía permiso de administrador
sobre la organización para autorizar la integración ahí directamente.

**Consecuencia práctica:** todo cambio a este código necesita subirse
a los dos remotos (`origin` y `fork`) para que se refleje en
producción. Ver instrucciones completas de cómo resolver esto de raíz
en [`NOTA-DEUDA-TECNICA-FORK.md`](./NOTA-DEUDA-TECNICA-FORK.md).

## Troubleshooting

**Error 403 al leer issues en el workflow de indexación (repo de
datos):** revisar que el repo tenga "Read and write permissions"
habilitado en Settings → Actions → General → Workflow permissions —
el permiso declarado en el YAML del workflow no puede superar ese
techo configurado a nivel de repositorio.

**El modelo de Groq responde con error 404 "model not found":** el
modelo fue deprecado. Revisar `console.groq.com/docs/models` para ver
el catálogo vigente y actualizar `GROQ_MODEL` en `api/ask.js`.

**El deployment queda en estado "Blocked" en Vercel:** típicamente
significa un problema de permisos de colaboración en el plan Hobby
(no soporta múltiples colaboradores en un repo privado, o el commit
está firmado con un email que no coincide con ningún colaborador
reconocido del repo). Ver la sección de deuda técnica arriba.

**Las respuestas citan detalles que no están en el issue real:**
verificar que `data/index.json` (en el repo de datos) tenga el campo
`body` poblado con el contenido real del issue, no solo metadata — sin
eso, el modelo no tiene información real de la cual partir y tiende a
completar con conocimiento general.
