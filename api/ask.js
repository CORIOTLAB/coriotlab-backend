/**
 * api/ask.js
 * ----------
 * Endpoint de consulta en lenguaje natural sobre la base de errores de
 * CORIOTLAB. Flujo:
 *   1. Trae data/index.json desde el repo de GitHub (autenticado, sirve
 *      tanto si el repo es público como privado).
 *   2. Genera el embedding de la pregunta con el MISMO modelo usado en
 *      la indexación (paraphrase-multilingual-MiniLM-L12-v2 vía
 *      Transformers.js), para que los vectores sean comparables.
 *   3. Busca los issues más similares por similitud coseno.
 *   4. Le pasa esos issues como contexto a un modelo de Groq para que
 *      redacte una respuesta en lenguaje natural, citando la fuente.
 *
 * Variables de entorno requeridas (configurar en Vercel, nunca en código):
 *   - GROQ_API_KEY: API key de console.groq.com
 *   - GH_READ_TOKEN: Personal Access Token de GitHub con permiso de
 *     lectura de contenido del repo (funciona igual si el repo es
 *     público o privado)
 *   - GH_REPO: "CORIOTLAB/coriotlab-registro-errores"
 */

import { pipeline } from '@xenova/transformers';

const EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const MIN_SIMILARITY = 0.3; // umbral: por debajo de esto, se considera "no relevante"
const MAX_MATCHES = 4;

// El pipeline de embeddings se reutiliza entre invocaciones "calientes"
// de la misma función (Vercel reutiliza el contenedor mientras esté
// activo), para no recargar el modelo en cada solicitud.
let embedderPromise = null;
function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', EMBEDDING_MODEL, {
      quantized: true, // versión cuantizada: más liviana, calidad casi idéntica
    });
  }
  return embedderPromise;
}

async function fetchIndex() {
  const repo = requireEnv('GH_REPO');
  const token = requireEnv('GH_READ_TOKEN');

  const url = `https://api.github.com/repos/${repo}/contents/data/index.json`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      // El media type "raw" hace que GitHub devuelva el contenido
      // directo del archivo, sin necesidad de decodificar base64.
      Accept: 'application/vnd.github.raw+json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `No se pudo obtener el índice desde GitHub (status ${response.status}): ${body}`
    );
  }

  return response.json();
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta configurar la variable de entorno '${name}' en Vercel.`);
  }
  return value;
}

function cosineSimilarity(a, b) {
  // Ambos vectores ya vienen normalizados (norm=1) tanto en la
  // indexación (Python) como en la consulta (JS), así que el producto
  // punto es directamente la similitud coseno.
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

function findTopMatches(queryEmbedding, issues) {
  const scored = issues
    .map((issue) => ({
      issue,
      score: cosineSimilarity(queryEmbedding, issue.embedding),
    }))
    .filter((entry) => entry.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, MAX_MATCHES);
}

async function askGroq(question, matches) {
  const apiKey = requireEnv('GROQ_API_KEY');

  const context = matches
    .map(
      (m) =>
        `[Issue #${m.issue.id}] ${m.issue.title}\n` +
        `Estado: ${m.issue.state} | Labels: ${m.issue.labels.join(', ')}\n` +
        `URL: ${m.issue.url}`
    )
    .join('\n\n');

  const systemPrompt =
    'Eres el asistente de la base de conocimiento de errores de CORIOTLAB ' +
    '(Sistemas de Control y Robótica, ITM Medellín). Respondes SOLO con base ' +
    'en los issues de contexto que se te dan. Si ninguno responde realmente ' +
    'la pregunta, dilo con claridad en vez de inventar una solución. Siempre ' +
    'que menciones un caso, cita su número de issue (#N) y su URL. Responde ' +
    'en español, de forma técnica, directa y breve.';

  const userPrompt = `Pregunta: ${question}\n\nIssues relevantes encontrados:\n\n${context}`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error de la API de Groq (status ${response.status}): ${body}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

export default async function handler(req, res) {
  // GET simple para verificar que el despliegue está vivo, sin gastar
  // cuota de Groq ni cargar el modelo de embeddings.
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      message: 'API de consulta de errores CORIOTLAB activa.',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido. Usa POST.' });
  }

  const { question } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Falta el campo "question" (texto) en el body.' });
  }

  try {
    const [index, embedder] = await Promise.all([fetchIndex(), getEmbedder()]);

    if (!index.issues || index.issues.length === 0) {
      return res.status(200).json({
        answer: 'Todavía no hay errores registrados en la base de conocimiento.',
        matches: [],
      });
    }

    const output = await embedder(question, { pooling: 'mean', normalize: true });
    const queryEmbedding = Array.from(output.data);

    const matches = findTopMatches(queryEmbedding, index.issues);

    if (matches.length === 0) {
      return res.status(200).json({
        answer:
          'No encontré ningún error registrado que parezca relacionado con tu pregunta. ' +
          'Si el error ya te pasó a ti, considera registrarlo para que le sirva a alguien más.',
        matches: [],
      });
    }

    const answer = await askGroq(question, matches);

    return res.status(200).json({
      answer,
      matches: matches.map((m) => ({
        id: m.issue.id,
        title: m.issue.title,
        url: m.issue.url,
        similitud: Number(m.score.toFixed(3)),
      })),
    });
  } catch (error) {
    console.error('Error en /api/ask:', error);
    return res.status(500).json({
      error: 'Error interno al procesar la consulta.',
      detail: error.message,
    });
  }
}
