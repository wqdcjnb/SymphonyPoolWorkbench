function installJointSubmission(config) {
  // Keep the guard in the page across a human-verification handoff. It changes
  // only the user's message grouping, never authentication or model settings.
  window.__symphonyJointSubmissionControl?.disable();
  let active = true;
  Object.defineProperty(window, '__symphonyJointSubmissionControl', { configurable: true,
    value: { disable() { active = false; } } });
  const state = { accepted: 0, error: null, originalMessages: 0, messages: 0, images: 0, videos: 0, textPresent: false, restoredRetries: 0 };
  let originalRequest = null;
  Object.defineProperty(window, '__symphonyJointSubmission', { value: state, configurable: true });
  // The native challenge retry can use rendered list text. Normalize only
  // line-leading Markdown bullets; keep minus signs, ranges and hyphenated words.
  const normalized = value => String(value || '').replace(/^[ \t]{0,3}[-*+][ \t]+(?=\S)/gm, '').replace(/\s+/gu, '');
  const wanted = normalized(config.prompt);
  const domain = config.service === 'dola' ? 'dola.com' : 'doubao.com';
  const target = (url, method) => {
    const parsed = new URL(url, window.location.href);
    return String(method || 'GET').toUpperCase() === 'POST'
      && (parsed.hostname === domain || parsed.hostname.endsWith('.' + domain))
      && /^\/(?:samantha\/)?chat\/completion\/?$/.test(parsed.pathname);
  };
  const fail = code => { state.error = code; throw new Error(code); };
  const clone = value => JSON.parse(JSON.stringify(value));
  const messageId = message => typeof message.local_message_id === 'string'
    && /^[A-Za-z0-9_-]{1,160}$/.test(message.local_message_id) ? message.local_message_id : null;
  function isDoubaoConfirmation(data, text) {
    if (config.service !== 'doubao') return false;
    if (text.trim() === '确认生成') return true;
    // The video composer wraps a control reply too. Validate both its input
    // and its generated text, rather than treating it as a missing image.
    let params = data.chat_ability?.ability_param;
    try {
      for (let depth = 0; typeof params === 'string' && depth < 3; depth += 1) params = JSON.parse(params);
    } catch { return false; }
    const input = params?.input_box_content;
    if (input?.user_input_content !== '确认生成' || input.reply_message_format !== '生成视频：%s'
        || !/^\d+:\d+$/.test(params?.ratio || '') || !Number.isInteger(params?.duration)) return false;
    return text === `生成视频：确认生成，${params.ratio}`
      || text === `生成视频：确认生成，${params.ratio}，${params.duration}s`;
  }
  function prepare(body) {
    if (typeof body !== 'string') return fail('MULTIMODAL_UNSUPPORTED_PAYLOAD');
    let data;
    try { data = JSON.parse(body); } catch { return fail('MULTIMODAL_UNSUPPORTED_PAYLOAD'); }
    if (!Array.isArray(data.messages) || !data.messages.length) return fail('MULTIMODAL_UNSUPPORTED_PAYLOAD');
    const blocks = [];
    let images = 0, videos = 0;
    const texts = [];
    for (const message of data.messages) {
      if (!Array.isArray(message.content_block) || !message.content_block.length) return fail('MULTIMODAL_UNSUPPORTED_PAYLOAD');
      for (const block of message.content_block) {
        if (block.block_type === 10000 && typeof block.content?.text_block?.text === 'string') {
          texts.push(block.content.text_block.text);
        } else if (block.block_type === 10052 && Array.isArray(block.content?.attachment_block?.attachments)) {
          for (const attachment of block.content.attachment_block.attachments) {
            if (attachment.image && typeof attachment.image === 'object') images += 1;
            else if (attachment.video && typeof attachment.video === 'object') videos += 1;
            else return fail('MULTIMODAL_UNSUPPORTED_PAYLOAD');
          }
        } else return fail('MULTIMODAL_UNSUPPORTED_PAYLOAD');
        blocks.push(block);
      }
    }
    // Doubao may explicitly ask for a confirmation after receiving the complete
    // original request. That control message must not re-upload the pictures.
    if (state.accepted && !images && !videos && data.messages.length === 1 && blocks.length === 1
        && texts.length === 1 && isDoubaoConfirmation(data, texts[0])) {
      state.error = null;
      return body;
    }
    state.lastAttempt = { messages: data.messages.length, images, videos,
      textLengths: texts.map(text => text.length), promptMatched: texts.some(text => normalized(text).includes(wanted)),
      knownMessage: Boolean(originalRequest && data.messages.length === 1
        && originalRequest.messageIds.includes(messageId(data.messages[0]))),
      sameMedia: Boolean(originalRequest && JSON.stringify(blocks.filter(block => block.block_type === 10052)) === originalRequest.media) };
    if (images !== config.images || videos !== config.videos) return fail('MULTIMODAL_ATTACHMENTS_MISMATCH');
    // Dola's native human-verification callback can resend just its original
    // attachment message. Restore the exact text/settings from this guard's
    // first complete request only when both its local message ID and all media
    // blocks match. A changed/new prompt or attachment is never repaired.
    if (config.service === 'dola' && originalRequest && data.messages.length === 1
        && !texts.some(text => text.trim())
        && originalRequest.messageIds.includes(messageId(data.messages[0]))
        && JSON.stringify(blocks.filter(block => block.block_type === 10052)) === originalRequest.media) {
      blocks.splice(0, blocks.length, ...clone(originalRequest.blocks));
      texts.splice(0, texts.length, ...originalRequest.texts);
      if (originalRequest.chatAbility !== undefined) data.chat_ability = clone(originalRequest.chatAbility);
      state.restoredRetries += 1;
    }
    if (!wanted || !texts.some(text => normalized(text).includes(wanted))) return fail('MULTIMODAL_PROMPT_MISSING');
    if (!originalRequest) originalRequest = {
      messageIds: data.messages.map(messageId).filter(Boolean), blocks: clone(blocks), texts: [...texts],
      media: JSON.stringify(blocks.filter(block => block.block_type === 10052)),
      chatAbility: data.chat_ability === undefined ? undefined : clone(data.chat_ability),
    };
    // Preserve the final user-message identity to which the platform replies,
    // and retain every attachment/text block and its original metadata/order.
    const originalMessages = data.messages.length;
    data.messages = [{ ...data.messages.at(-1), content_block: blocks }];
    const result = JSON.stringify(data);
    state.accepted += 1;
    state.error = null;
    state.originalMessages = originalMessages;
    state.messages = 1;
    state.images = images;
    state.videos = videos;
    state.textPresent = true;
    return result;
  }
  const originalFetch = window.fetch;
  window.fetch = async function(input, init) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const url = isRequest ? input.url : String(input);
    const method = init?.method || (isRequest ? input.method : 'GET');
    if (!active || !target(url, method)) return originalFetch.call(this, input, init);
    const body = init?.body !== undefined ? init.body : (isRequest ? await input.clone().text() : undefined);
    const next = { ...init, body: prepare(body) };
    return originalFetch.call(this, input, next);
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const requests = new WeakMap();
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    requests.set(this, { method, url });
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const request = requests.get(this);
    return originalSend.call(this, active && request && target(request.url, request.method) ? prepare(body) : body);
  };
}
