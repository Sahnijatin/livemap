import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/geist-sans/latin-400.css';
import '@fontsource/geist-sans/latin-500.css';
import '@fontsource/geist-sans/latin-600.css';
import '@fontsource/geist-sans/latin-700.css';
import '@fontsource/geist-mono/latin-400.css';
import '@fontsource/geist-mono/latin-500.css';
import './styles.css';
import { App } from './App';
import { connect } from './connection';

const render = () => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// An export (`livemap export`) embeds its history: replay it, with no socket and no API calls. Only the
// export build (mode `export`) carries this branch, so the live app never ships the replay code.
const data = import.meta.env.MODE === 'export' ? document.getElementById('livemap-data') : null;
if (data) {
  import('./exportBoot').then(m => m.bootExport(data)).then(render, (e: unknown) => {
    console.error('LiveMap export could not be read:', e);
    document.body.textContent = 'This LiveMap export could not be read.';
  });
} else {
  connect();
  render();
}
