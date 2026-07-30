(() => {
  const blocks = Array.from(document.querySelectorAll('[data-public-comments]'));
  if (!blocks.length) return;

  const escapeNext = () => `${window.location.pathname}${window.location.search || ''}`;

  function setText(root, selector, value) {
    const node = root.querySelector(selector);
    if (node) node.textContent = value || '';
  }

  function setStatus(root, message) {
    setText(root, '[data-comments-status]', message);
  }

  function renderComments(root, comments) {
    const list = root.querySelector('[data-comments-list]');
    if (!list) return;
    list.replaceChildren();

    if (!Array.isArray(comments) || comments.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'creator-comments-empty';
      empty.textContent = 'No creator comments yet. Be the first streamer to leave one.';
      list.append(empty);
      return;
    }

    comments.forEach(comment => {
      const card = document.createElement('article');
      card.className = 'creator-comment-card';

      const quote = document.createElement('p');
      quote.textContent = comment.comment || '';

      const footer = document.createElement('footer');
      const name = document.createElement('strong');
      name.textContent = comment.name || 'Creator';
      const role = document.createElement('span');
      role.textContent = comment.role || 'TikTok LIVE creator';
      footer.append(name, role);

      card.append(quote, footer);
      list.append(card);
    });
  }

  function configureAuth(root, user) {
    const login = root.querySelector('[data-comments-login]');
    const form = root.querySelector('[data-comments-form]');
    const loginLink = root.querySelector('[data-comments-login-link]');
    const signupLink = root.querySelector('[data-comments-signup-link]');
    const next = encodeURIComponent(escapeNext());

    if (loginLink) loginLink.href = `/login?next=${next}`;
    if (signupLink) signupLink.href = `/signup?next=${next}`;

    if (user) {
      if (login) login.hidden = true;
      if (form) form.hidden = false;
      const label = user.name || user.tiktokUsername || user.email || 'your creator account';
      setText(root, '[data-comments-identity]', `Commenting as ${label}`);
      return;
    }

    if (login) login.hidden = false;
    if (form) form.hidden = true;
    setText(root, '[data-comments-identity]', '');
  }

  async function loadComments() {
    const response = await fetch('/api/public/comments', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`comments ${response.status}`);
    return response.json();
  }

  async function loadUser() {
    try {
      const response = await fetch('/api/public/comment-session', {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) return null;
      const body = await response.json();
      return body?.user || null;
    } catch (_err) {
      return null;
    }
  }

  async function submitComment(root, textarea, button) {
    const comment = String(textarea?.value || '').trim();
    if (comment.length < 8) {
      setStatus(root, 'Write a slightly longer comment.');
      return;
    }

    const originalText = button?.textContent || 'Post comment';
    if (button) {
      button.disabled = true;
      button.textContent = 'Posting...';
    }
    setStatus(root, 'Posting comment...');

    try {
      const response = await fetch('/api/public/comments', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({ comment }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) {
        configureAuth(root, null);
        setStatus(root, body.error || 'Log in with your creator account to comment.');
        return;
      }
      if (!response.ok || body.success === false) {
        setStatus(root, body.error || 'Unable to post comment.');
        return;
      }
      textarea.value = '';
      renderComments(root, body.comments || []);
      setStatus(root, 'Comment posted.');
    } catch (_err) {
      setStatus(root, 'Unable to post comment right now.');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  }

  async function init() {
    try {
      const [commentsBody, user] = await Promise.all([loadComments(), loadUser()]);
      blocks.forEach(root => {
        renderComments(root, commentsBody.comments || []);
        configureAuth(root, user);
        const form = root.querySelector('[data-comments-form]');
        const textarea = root.querySelector('[data-comments-textarea]');
        const button = form?.querySelector('button[type="submit"]');
        if (form && textarea) {
          form.addEventListener('submit', event => {
            event.preventDefault();
            submitComment(root, textarea, button);
          });
        }
      });
    } catch (_err) {
      blocks.forEach(root => setStatus(root, 'Unable to load comments right now.'));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
