export function showToast(message: string): void {
  const toast = document.createElement("div");
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #333;
    color: white;
    padding: 10px 18px;
    border-radius: 6px;
    font-size: 0.9rem;
    z-index: 9999;
    box-shadow: 0 0 6px rgba(0,0,0,0.3);
  `;
  document.body.append(toast);
  setTimeout(() => {
    toast.remove();
  }, 2500);
}
