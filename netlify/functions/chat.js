'use strict';

const MODEL = 'gemini-2.5-flash';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MAX_CHARS = 500;
const HISTORY_LIMIT = 8;

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return reply(405, { error: 'Método não permitido.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY não configurada.');
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

  // Histórico: últimas 8 mensagens válidas, começando sempre por "user".
  const rawHistory = Array.isArray(payload.history) ? payload.history.slice(-HISTORY_LIMIT) : [];
  const contents = [];
  for (const h of rawHistory) {
    if (!h || typeof h.text !== 'string') continue;
    const role = h.role === 'model' ? 'model' : 'user';
    if (contents.length === 0 && role !== 'user') continue;
    contents.push({ role, parts: [{ text: h.text.slice(0, 4000) }] });
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 800,
          thinkingConfig: { thinkingBudget: 0 }
        }
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('Erro Gemini', res.status, detail.slice(0, 500));
      if (res.status === 429) {
        return reply(429, { error: 'Muitas perguntas ao mesmo tempo. Aguarde alguns segundos e tente de novo.' });
      }
      if (res.status === 400 || res.status === 403) {
        return reply(502, { error: 'Houve um problema de configuração com a IA. Avise a equipe do projeto.' });
      }
      return reply(502, { error: 'A IA está indisponível no momento. Tente novamente em instantes.' });
    }

    const data = await res.json();
    if (data.promptFeedback && data.promptFeedback.blockReason) {
      return reply(200, { reply: 'Não posso responder a essa pergunta. Que tal tentar outro assunto da escola ou da ciência?' });
    }

    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content &&
                   data.candidates[0].content.parts) || [];
    const text = parts.map((p) => p.text || '').join('').trim();
    if (!text) {
      return reply(502, { error: 'A IA não conseguiu gerar uma resposta. Tente reformular a pergunta.' });
    }
    return reply(200, { reply: text });
  } catch (err) {
    console.error('Falha ao chamar Gemini:', err);
    if (err.name === 'AbortError') {
      return reply(504, { error: 'A IA demorou demais para responder. Tente novamente.' });
    }
    return reply(502, { error: 'Não foi possível falar com a IA agora. Tente novamente.' });
  } finally {
    clearTimeout(timer);
  }
};
