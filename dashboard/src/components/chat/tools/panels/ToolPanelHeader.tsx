import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface ToolPanelHeaderProps {
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
  rightContent?: ReactNode;
  className?: string;
  titleClassName?: string;
}

export function ToolPanelHeader({
  icon,
  title,
  meta,
  rightContent,
  className,
  titleClassName,
}: ToolPanelHeaderProps) {
  return (
    <div className={cn('flex items-center gap-2 px-3 py-1.5 border-b min-w-0', className)}>
      {icon}
      <span className={cn('text-xs font-medium text-foreground', titleClassName)}>{title}</span>
      {meta ? <div className="min-w-0">{meta}</div> : null}
      {rightContent ? <div className="ml-auto">{rightContent}</div> : null}
    </div>
  );
}
