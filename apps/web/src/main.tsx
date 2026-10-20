import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LoginPage } from './LoginPage';

const root = document.getElementById('root');
if (!root) throw new Error('#root가 없습니다');

createRoot(root).render(
  <StrictMode>
    <LoginPage />
  </StrictMode>,
);
