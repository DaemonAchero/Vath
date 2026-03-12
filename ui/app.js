const app = document.getElementById('app');

const state = {
  jobId: null,
  cursor: 0,
  polling: false,
  previewShown: false
};

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

const shell = el('div', 'shell');
const header = el('div', 'brand');
header.innerHTML = `
  <div>
    <h1>AI - Vath</h1>
  </div>
`;

const chat = el('div', 'chat');
const composer = el('form', 'composer');
composer.innerHTML = `
  <input type="text" placeholder="Clone this site: https://example.com" />
  <button type="submit">Mirror</button>
`;

shell.appendChild(header);
shell.appendChild(chat);
shell.appendChild(composer);
app.appendChild(shell);

function addMessage(role, html) {
  const msg = el('div', `msg ${role}`);
  msg.classList.add('msg-enter');
  const bubble = el('div', 'bubble', html);
  const meta = el('div', 'msg-meta');
  const copyBtn = el('button', 'copy-btn', 'Copy');
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', async () => {
    const text = bubble.innerText.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = 'Copied';
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 1200);
    } catch {
      copyBtn.textContent = 'Failed';
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 1200);
    }
  });
  meta.appendChild(copyBtn);
  if (role === 'assistant') {
    const row = el('div', 'meta-row');
    row.appendChild(meta);
    msg.appendChild(bubble);
    msg.appendChild(row);
  } else {
    msg.appendChild(bubble);
    msg.appendChild(meta);
  }
  chat.appendChild(msg);
  chat.scrollTop = chat.scrollHeight;
  return bubble;
}

function addAssistantBts() {
  const intros = [
    "Alright, I'm on it. Kicking off the replica now.",
    "Got you. Spinning up the mirror and getting started.",
    "Say less. I’ll handle the heavy lifting.",
    "Okay bestie, let’s make this look good.",
    "Cool, I’m diving in. Give me a sec.",
    "You really picked a fun one — I’m cloning it now.",
    "Relax, I’ve got this. Starting the extraction.",
    "Alright champ, let’s see what this site is hiding.",
    "Okay, okay… I’ll do it. Starting now.",
    "Fine, I’ll be nice. Let’s clone this thing."
  ];
  const intro = intros[Math.floor(Math.random() * intros.length)];
  const bubble = addMessage('assistant', `
    <div class="assistant-block">
      <div class="assistant-text">${intro} Everything stays on your machine.</div>
      <details class="bts" open>
        <summary>Behind the scenes</summary>
        <pre id="bts-log">Boot sequence initialized...</pre>
        <div class="typing" aria-label="Processing">
          <span></span><span></span><span></span>
        </div>
      </details>
      <div class="actions" data-actions style="display:none;"></div>
      <div class="preview-slot"></div>
    </div>
  `);
  return {
    logEl: bubble.querySelector('#bts-log'),
    typingEl: bubble.querySelector('.typing'),
    actionsEl: bubble.querySelector('[data-actions]'),
    previewSlot: bubble.querySelector('.preview-slot')
  };
}

function addApologyMessage() {
  const apologies = [
    "Sorry about that — this site is fighting back. Want to try another one?",
    "My bad, this one didn’t go through. Some sites block capture.",
    "I couldn’t finish that capture. We can try a different site if you want.",
    "Apologies — that site didn’t cooperate. Try again or pick another URL."
  ];
  addMessage('assistant', apologies[Math.floor(Math.random() * apologies.length)]);
}

function addActions(container, zipUrl, previewUrl, wrapUrl) {
  const { actionsEl, previewSlot } = container;
  actionsEl.style.display = 'flex';
  const activeUrl = previewUrl;
  const openUrl = wrapUrl ? `${wrapUrl}?t=${Date.now()}` : previewUrl;
  actionsEl.innerHTML = `
    <span class="assistant-text">Replica ready. Download the project or open the preview.</span>
    <div class="action-row">
      <a href="${zipUrl}" download>Download replica-react.zip</a>
      <a href="${openUrl}" target="_blank" rel="noreferrer" data-open>Open preview</a>
      <button type="button" data-preview>Preview here</button>
    </div>
  `;

  const button = actionsEl.querySelector('[data-preview]');

  button.addEventListener('click', () => {
    if (previewSlot.querySelector('iframe')) return;
    const frame = document.createElement('iframe');
    frame.className = 'preview-frame';
    frame.src = activeUrl;
    previewSlot.appendChild(frame);
  });
}

function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

async function startClone(url, container) {
  const res = await fetch('/api/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Unable to start clone job.');
  }
  const data = await res.json();
  state.jobId = data.id;
  state.cursor = 0;
  pollStatus(container);
}

async function pollStatus(container) {
  if (!state.jobId || state.polling) return;
  state.polling = true;

  const tick = async () => {
    try {
      const res = await fetch(`/api/status?id=${state.jobId}&cursor=${state.cursor}`);
      if (!res.ok) throw new Error('Status unavailable.');
      const data = await res.json();
      if (data.logs && data.logs.length) {
        container.logEl.textContent += '\n' + data.logs.join('\n');
      }
      state.cursor = data.cursor || state.cursor;

      if (data.state === 'done') {
        if (container.typingEl) container.typingEl.style.display = 'none';
        addActions(container, data.zipUrl, data.previewUrl, data.wrapUrl);
        state.polling = false;
        return;
      }
      if (data.state === 'error') {
        if (container.typingEl) container.typingEl.style.display = 'none';
        addMessage('assistant', `Something failed. <small>${data.error}</small>`);
        addApologyMessage();
        state.polling = false;
        return;
      }
      setTimeout(tick, 1200);
    } catch (err) {
      addMessage('assistant', `Status check failed. <small>${err.message}</small>`);
      state.polling = false;
    }
  };

  tick();
}

composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.polling) {
    addMessage('assistant', 'I’m still processing the current request — please wait a moment.');
    return;
  }
  const input = composer.querySelector('input');
  const text = input.value.trim();
  if (!text) return;

  addMessage('user', text);
  input.value = '';

  const url = extractUrl(text);
  if (!url) {
    addMessage('assistant', 'Add a URL like: <small>Clone this site: https://example.com</small>');
    return;
  }

  const container = addAssistantBts();
  try {
    await startClone(url, container);
  } catch (err) {
    addMessage('assistant', `Unable to start. <small>${err.message}</small>`);
  }
});

addMessage(
  'assistant',
  `Could you clarify what you want me to clone?<br/>
   Please paste the text, link, code, image, or file you want duplicated.<br/><br/>
   Once I see it, I can:
   <ul>
     <li>replicate it exactly,</li>
     <li>recreate something similar, or</li>
     <li>modify it if needed.</li>
   </ul>`
);
