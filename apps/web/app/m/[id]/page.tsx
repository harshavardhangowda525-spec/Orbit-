'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { apiUrl } from '@/lib/api';

/** A message from Orbit was opened: record the click, then go where it points. */
export default function OpenMessage() {
  const { id } = useParams<{ id: string }>();
  useEffect(() => {
    if (/^[0-9a-f-]{36}$/i.test(id)) window.location.replace(`${apiUrl()}/m/${id}/click`);
    else window.location.replace('/bridge');
  }, [id]);
  return null;
}
