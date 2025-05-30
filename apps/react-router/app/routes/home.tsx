// import type { Route } from './+types/home';
import LandingPage from '../components/LandingPage';

export function meta() {
  return [
    { title: 'ThreadWise - AI Conversation Platform' },
    { name: 'description', content: 'Start meaningful conversations with our AI agent' },
  ];
}

export default function Home() {
  return <LandingPage />;
}
