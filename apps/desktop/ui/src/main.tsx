import { createRoot } from 'react-dom/client';
import './global.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import { Assistant } from './components/Assistant/Assistant';

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

const root = createRoot(container);

root.render(
  <Assistant />
);