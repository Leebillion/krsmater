import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './KrsMasterApp.tsx';
import './index.css';

registerSW({
  immediate: true,
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent('krs-pwa-update-ready'));
  },
  onOfflineReady() {
    window.dispatchEvent(new CustomEvent('krs-pwa-offline-ready'));
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
