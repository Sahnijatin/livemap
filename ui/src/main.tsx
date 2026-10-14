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

connect();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
