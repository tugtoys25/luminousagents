const signOut = document.getElementById('staff-signout');
if (signOut)
  signOut.addEventListener('click', async () => {
    signOut.disabled = true;
    try {
      await fetch('/api/admin/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } finally {
      window.location.href = '/admin/login';
    }
  });
