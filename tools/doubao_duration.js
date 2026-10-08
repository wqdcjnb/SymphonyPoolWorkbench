function installDoubaoDuration(config) {
  // Change only the selected video's ability parameters, before the platform's
  // existing fetch/XHR implementation signs and sends the request.
  const state = { patched: 0, confirmations: 0, nativeDurationRemoved: 0, duration: null, error: null };
  Object.defineProperty(window, '__symphonyDoubaoDuration', { value: state, configurable: true });
  const fail = code => { state.error = code; throw new Error(code); };
  const models = { 'Seedance 2.0 Fast': 'seedance_v2.0', 'Seedance 2.0 Mini': 'seedance_v2.0_mini' };
  if (config.duration !== 15 || !models[config.model]) fail('DOUBAO_DURATION_CONFIG_INVALID');
  const target = (url, method) => {
    const parsed = new URL(url, window.location.href);
    return String(method).toUpperCase() === 'POST'
      && ['doubao.com', 'www.doubao.com'].includes(parsed.hostname)
      && /^\/(?:samantha\/)?chat\/completion\/?$/.test(parsed.pathname);
  };
  const isConfirmation = data => {
    const messages = data.messages;
    const blocks = messages?.[0]?.content_block;
    return messages?.length === 1 && blocks?.length === 1
      && blocks[0].block_type === 10000
      && blocks[0].content?.text_block?.text?.trim() === '确认生成';
  };
  function prepare(body) {
    let data;
    try {
      if (typeof body !== 'string') throw new Error();
      data = JSON.parse(body);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    } catch { return fail('DOUBAO_DURATION_PAYLOAD_UNSUPPORTED'); }
    if (data.chat_ability?.ability_param == null) {
      if (!(state.patched > 0 || config.confirmationOnly) || !isConfirmation(data)) return fail('DOUBAO_DURATION_PARAMETERS_MISSING');
      state.confirmations += 1;
      state.duration = config.duration;
      state.error = null;
      return body;
    }
    let params = data.chat_ability.ability_param;
    let depth = 0;
    try {
      while (typeof params === 'string' && depth < 3) { params = JSON.parse(params); depth += 1; }
    } catch { return fail('DOUBAO_DURATION_PAYLOAD_UNSUPPORTED'); }
    if (!params || typeof params !== 'object' || Array.isArray(params)
        || !Number.isInteger(params.duration) || params.duration < 4 || params.duration > 15) {
      return fail('DOUBAO_DURATION_PARAMETERS_MISSING');
    }
    if (params.model !== models[config.model] || params.ratio !== config.ratio) {
      return fail('PLATFORM_PARAMETERS_MISMATCH');
    }
    const input = params.input_box_content;
    const source = input?.user_input_content;
    const blocks = data.messages?.flatMap(message => message.content_block || []);
    const texts = blocks?.filter(block => block.block_type === 10000);
    if (typeof source !== 'string' || !source.trim() || texts?.length !== 1) {
      return fail('DOUBAO_DURATION_PAYLOAD_UNSUPPORTED');
    }
    if ((config.confirmationOnly && source !== '确认生成')
        || (config.prompt && source !== config.prompt && source !== '确认生成')) {
      return fail('DOUBAO_DURATION_PARAMETERS_MISSING');
    }
    const format = input.reply_message_format;
    if (format != null && format !== '生成视频：%s') return fail('DOUBAO_DURATION_PAYLOAD_UNSUPPORTED');
    const rendered = format ? format.replace('%s', source) : source;
    const block = texts[0].content?.text_block;
    // The native composer appends its visible slider value to the chat text.
    // Keep the user's prompt intact; remove only this observed, generated suffix.
    if (block?.text === `${rendered}，${params.ratio}，${params.duration}s`) {
      block.text = `${rendered}，${params.ratio}`;
      state.nativeDurationRemoved += 1;
    } else if (![source, rendered, `${rendered}，${params.ratio}`].includes(block?.text)) {
      return fail('DOUBAO_DURATION_PAYLOAD_UNSUPPORTED');
    }
    params.duration = config.duration;
    for (let index = 0; index < depth; index += 1) params = JSON.stringify(params);
    data.chat_ability.ability_param = params;
    state.patched += 1;
    state.duration = config.duration;
    state.error = null;
    return JSON.stringify(data);
  }
  const originalFetch = window.fetch;
  window.fetch = async function(input, init) {
    const request = typeof Request !== 'undefined' && input instanceof Request;
    const url = request ? input.url : String(input);
    const method = init?.method || (request ? input.method : 'GET');
    if (!target(url, method)) return originalFetch.call(this, input, init);
    const body = init?.body !== undefined ? init.body : (request ? await input.clone().text() : undefined);
    return originalFetch.call(this, input, { ...init, body: prepare(body) });
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const requests = new WeakMap();
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    requests.set(this, { method, url });
    return originalOpen.call(this, method, url, ...args);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const request = requests.get(this);
    return originalSend.call(this, request && target(request.url, request.method) ? prepare(body) : body);
  };
}
