const createButton = document.getElementById('create-room');
const errorText = document.getElementById('error');

createButton.addEventListener('click', async () => {
  createButton.disabled = true;
  errorText.hidden = true;
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error(res.statusText);
    const { roomId } = await res.json();
    location.href = `/r/${roomId}`;
  } catch {
    errorText.textContent = '部屋を作れませんでした。もう一度お試しください。';
    errorText.hidden = false;
    createButton.disabled = false;
  }
});
