import { Icon } from '@/components/ui/Icon';

interface PageProps {
  title: string;
  subtitle?: string;
  onBack: () => void;
  children: React.ReactNode;
}

export function Page({ title, subtitle, onBack, children }: PageProps) {
  return (
    <div className="apollo-page">
      <div className="apollo-page-top">
        <button type="button" className="apollo-icon-btn" onClick={onBack} aria-label="Volver">
          <Icon n="back" size={18} />
        </button>
        <span className="apollo-page-small">{title}</span>
      </div>
      <div className="apollo-page-scroll">
        <div className="apollo-page-big">
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}
