// Shared internal-navigation link: a real <a href> whose click handler only intercepts plain left
// clicks, so Cmd/Ctrl/Shift-click, middle-click and links with an explicit target still behave
// like ordinary links instead of being swallowed into an in-place navigation.
import type { MouseEvent, ReactNode } from 'react';
import { navigate } from './api';

export default function Link({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.currentTarget.target
    ) {
      return;
    }
    event.preventDefault();
    navigate(href);
  };

  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
