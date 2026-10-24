import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import Invitation from './Invitation.jsx';
import './style.css';

const Admin = lazy(() => import('./Admin.jsx'));
const isAdmin = location.pathname === '/admin' || location.pathname.startsWith('/admin/');

createRoot(document.getElementById('root')).render(
  isAdmin ? <Suspense fallback={<p style={{ padding: 24 }}>Cargando…</p>}><Admin/></Suspense> : <Invitation/>
);
