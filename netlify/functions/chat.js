'use strict';

/*
 * Modelos tentados em ordem. O primeiro que responder vence.
 * Para forçar um modelo, crie a variável de ambiente GEMINI_MODEL no Netlify
 * (ex.: gemini-3.5-flash). Ela passa a ser a primeira da lista.
 */
const DEFAULT_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash'];
const MODELS = [process.env.GEMINI_MODEL, ...DEFAULT_MODELS].filter(Boolean)
  .filter((m, i, arr) => arr.indexOf(m) === i);

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const MAX_CHARS = 500;
const HISTORY_LIMIT = 8;
const TOTAL_MS = 9000;  // a função do Netlify é cortada perto de 10 s
const PER_MODEL_MS = 5000; // cada modelo (menos o último) tem no máximo isso, para sobrar tempo ao próximo

const SYSTEM_PROMPT = [
  'Você é o assistente de IA da Feira de Ciências da escola, cujo tema é "IA e Escrita por Voz".',
  'Responda SEMPRE em português do Brasil.',
  'Seja didático, claro e acolhedor, voltado a um público escolar: alunos, pais e professores.',
  'Dê respostas curtas, de 2 a 5 parágrafos curtos.',
  'Use texto corrido simples, sem markdown, sem asteriscos, sem listas e sem emojis, pois a resposta também será lida em voz alta.',
  'Se não souber algo, diga isso com honestidade.',
  'Recuse com educação qualquer pedido impróprio para um ambiente escolar.'
].join(' ');

const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};
const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gemini 3.x usa thinkingLevel; Gemini 2.5 usa thinkingBudget.
function thinkingFor(model) {
  if (model.startsWith('gemini-3')) return { thinkingLevel: 'low' };
  if (model.startsWith('gemini-2.5')) return { thinkingBudget: 0 };
  return null;
}

function buildBody(model, contents, withThinking) {
  const generationConfig = { temperature: 0.7, maxOutputTokens: 900 };
  const thinking = withThinking ? thinkingFor(model) : null;
  if (thinking) generationConfig.thinkingConfig = thinking;
  return JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig
  });
}

async function callOnce(model, body, apiKey, msLeft) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), msLeft);
  try {
    const res = await fetch(`${API_BASE}${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body,
      signal: controller.signal
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch (_) { /* não é JSON */ }
    return { status: res.status, ok: res.ok, json, raw };
  } finally {
    clearTimeout(timer);
  }
}

function extractText(data) {
  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content &&
                 data.candidates[0].content.parts) || [];
  return parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
}

exports.handler = async (event) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();

  // Diagnóstico: abrir /.netlify/functions/chat no navegador mostra se a chave chegou (sem revelá-la).
  if (event.httpMethod === 'GET') {
    return reply(200, { ok: true, chaveConfigurada: Boolean(apiKey), modelos: MODELS });
  }
  if (event.httpMethod !== 'POST') {
    return reply(405, { error: 'Método não permitido.' });
  }
  if (!apiKey) {
    console.error('GEMINI_API_KEY não configurada (ou o deploy foi feito antes de criar a variável).');
    return reply(500, { error: 'O servidor ainda não está configurado. Avise a equipe do projeto.' });
  }
  if ((event.body || '').length > 20000) {
    return reply(413, { error: 'Requisição grande demais.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (_) {
    return reply(400, { error: 'Requisição inválida.' });
  }

  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (!message) return reply(400, { error: 'Escreva ou fale uma pergunta primeiro.' });
  if (message.length > MAX_CHARS) {
    return reply(400, { error: `A pergunta deve ter no máximo ${MAX_CHARS} caracteres.` });
  }

  // Histórico: últimas 8 mensagens válidas, sempre começando por "user".
  const rawHistory = Array.isArray(payload.history) ? payload.history.slice(-HISTORY_LIMIT) : [];
  const contents = [];
  for (const h of rawHistory) {
    if (!h || typeof h.text !== 'string') continue;
    const role = h.role === 'model' ? 'model' : 'user';
    if (contents.length === 0 && role !== 'user') continue;
    contents.push({ role, parts: [{ text: h.text.slice(0, 4000) }] });
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  const started = Date.now();
  const left = () => TOTAL_MS - (Date.now() - started);
  let lastStatus = 0;
  let blocked = false;

  for (const model of MODELS) {
    let withThinking = true;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (left() < 1500) break;

      let r;
      try {
        const isLast = MODELS.indexOf(model) === MODELS.length - 1;
        r = await callOnce(model, buildBody(model, contents, withThinking), apiKey, isLast ? left() : Math.min(left(), PER_MODEL_MS));
      } catch (err) {
        console.error(`[${model}] falha de rede/tempo:`, err.name || err);
        lastStatus = err.name === 'AbortError' ? 504 : 502;
        break; // sem tempo ou sem rede: tenta o próximo modelo apenas se sobrar tempo
      }

      if (r.ok) {
        const data = r.json || {};
        if (data.promptFeedback && data.promptFeedback.blockReason) { blocked = true; break; }
        const text = extractText(data);
        if (text) return reply(200, { reply: text });
        console.error(`[${model}] resposta vazia:`, (r.raw || '').slice(0, 300));
        lastStatus = 204;
        break; // tenta o próximo modelo
      }

      lastStatus = r.status;
      console.error(`Erro Gemini [${model}] ${r.status}:`, (r.raw || '').slice(0, 400));

      if (r.status === 401 || r.status === 403) {
        return reply(502, { error: `A chave da IA foi recusada (erro ${r.status}). Avise a equipe do projeto.` });
      }
      // 400 por causa da configuração de "thinking": repete sem ela.
      if (r.status === 400 && withThinking && /think/i.test(r.raw || '')) {
        withThinking = false;
        continue;
      }
      // Sobrecarga momentânea: repete uma vez o mesmo modelo.
      if ([500, 503, 504].includes(r.status) && attempt === 0) {
        await sleep(600);
        continue;
      }
      break; // 404 (modelo aposentado), 429 (cota) etc.: tenta o próximo modelo
    }
    if (blocked) break;
  }

  if (blocked) {
    return reply(200, { reply: 'Não posso responder a essa pergunta. Que tal tentar outro assunto da escola ou da ciência?' });
  }
  if (lastStatus === 429) {
    return reply(429, { error: 'Muitas perguntas ao mesmo tempo. Aguarde alguns segundos e tente de novo.' });
  }
  if (lastStatus === 504) {
    return reply(504, { error: 'A IA demorou demais para responder. Tente novamente.' });
  }
  return reply(502, { error: `A IA está indisponível no momento (erro ${lastStatus || 'desconhecido'}). Tente novamente em instantes.` });
};
