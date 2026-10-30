import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import Invitation from './Invitation.jsx';
import './style.css';

const Admin = lazy(() => import('./Admin.jsx'));
const PublicPoll = lazy(() => import('./PublicPoll.jsx'));
const params = new URLSearchParams(location.search);
const isPoll = params.has('poll');
const isInvitation = params.has('i');
const isAdmin = location.pathname === '/admin'
  || location.pathname.startsWith('/admin/')
  || (location.pathname === '/' && !isPoll && !isInvitation);

createRoot(document.getElementById('root')).render(
  isAdmin || isPoll
    ? <Suspense fallback={<p style={{ padding: 24 }}>Cargando…</p>}>{isAdmin ? <Admin/> : <PublicPoll/>}</Suspense>
    : <Invitation/>
);
