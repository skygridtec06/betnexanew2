const DEFAULT_BACKEND_URL = 'https://www.betnexabackend.co.ke';
const LEGACY_BACKEND_URLS = [
  'https://betnexanewbackend.vercel.app',
  'https://betnexabackend.vercel.app',
  'https://betnexabackend.co.ke',
  'https://www.betnexabackend.co.ke',
];

export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    const origin = window.location.origin;

    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return 'http://localhost:5000';
    }

    if (origin.includes('.vercel.app')) {
      return DEFAULT_BACKEND_URL;
    }
  }

  const configured = import.meta.env.VITE_API_URL?.trim();
  if (configured) {
    const normalized = configured.replace(/\/$/, '');

    if (LEGACY_BACKEND_URLS.some((legacy) => normalized === legacy || normalized.includes(legacy))) {
      return DEFAULT_BACKEND_URL;
    }

    return normalized;
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }

  return DEFAULT_BACKEND_URL;
}

export function buildApiUrl(path: string): string {
  const baseUrl = getApiBaseUrl();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

