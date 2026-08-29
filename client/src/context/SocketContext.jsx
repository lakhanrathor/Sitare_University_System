import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { tokenStore, API_ORIGIN } from '../lib/api';
import { useAuth } from './AuthContext';

const SocketContext = createContext(null);

export function SocketProvider({ children }) {
  const { user } = useAuth();
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!user) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setConnected(false);
      return;
    }

    // Empty API_ORIGIN connects same-origin (local dev); `|| undefined` rather
    // than `''` because socket.io-client treats an explicit empty string as a
    // literal (invalid) URL, not "use the current origin" the way omitting
    // the argument does.
    const socket = io(API_ORIGIN || undefined, {
      auth: { token: tokenStore.get() },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [user]);

  return (
    <SocketContext.Provider value={{ socket: socketRef, connected }}>
      {children}
    </SocketContext.Provider>
  );
}

export const useSocket = () => useContext(SocketContext);

/** Subscribe to a server event for the lifetime of a component. */
export function useSocketEvent(event, handler) {
  const { socket, connected } = useSocket();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const s = socket.current;
    if (!s) return;
    const fn = (...args) => handlerRef.current?.(...args);
    s.on(event, fn);
    return () => s.off(event, fn);
  }, [socket, connected, event]);
}

/** Join a subject room so faculty screens get live updates for that subject. */
export function useSubjectRoom(subjectId) {
  const { socket, connected } = useSocket();

  useEffect(() => {
    const s = socket.current;
    if (!s || !subjectId || !connected) return;
    s.emit('subject:join', subjectId);
    return () => s.emit('subject:leave', subjectId);
  }, [socket, connected, subjectId]);
}
