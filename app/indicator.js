if (new URLSearchParams(location.search).get('control') === 'true') {
  document.querySelector('#sharing').textContent = 'Remote control active';
}
document.querySelector('#stop').addEventListener('click', () => window.desktop.stopFromIndicator());
