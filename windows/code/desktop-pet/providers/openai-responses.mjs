export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
export class OpenAIRequestError extends Error {
  constructor(status, code) { super(status === 401 ? 'OpenAI Key 无效，请重新配置。' : status === 403 ? 'OpenAI 拒绝访问，请检查项目与模型权限。' : status === 429 && code === 'insufficient_quota' ? 'OpenAI API 可用额度不足，请检查 Platform 余额或项目预算。ChatGPT 登录额度与 API 额度独立。' : status === 429 && code === 'rate_limit_exceeded' ? 'OpenAI API 请求频率或 Token 速率超限，请稍后再试。' : status === 429 ? 'OpenAI API 返回 429，原因未明确；请检查 API 用量限制。' : `OpenAI 请求失败（HTTP ${status}），未自动重试。`); }
}
export function responseText(data) {
  if (data?.status !== 'completed') throw Error('OpenAI 回复未完整完成，未自动重试。');
  const text = (data.output ?? []).filter(item => item.type === 'message' && item.role === 'assistant')
    .flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('\n');
  if (!text.trim()) throw Error('OpenAI 未返回可显示的文字。');
  return text;
}
export async function requestOpenAI({ key, model, input, signal, fetcher = fetch }) {
  const response = await fetcher(OPENAI_RESPONSES_URL, {
    method: 'POST', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input, stream: false, store: false, max_output_tokens: 4096,
      instructions: '你是用户的桌面陪伴助手，请用自然、简洁的中文交流。你目前只支持文字对话和本次会话的上下文，没有执行工具、定时提醒、语音或长期记忆。不能声称已设置提醒、操作电脑或完成未实际执行的任务。' })
  });
  if (!response.ok) {
    // Classify fixed provider codes without displaying raw error text or keys.
    const detail = await response.json().catch(() => null);
    throw new OpenAIRequestError(response.status, detail?.error?.code);
  }
  return responseText(await response.json());
}
