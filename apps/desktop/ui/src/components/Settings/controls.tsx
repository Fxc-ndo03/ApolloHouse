import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/Icon';

export function Label({ children, value }: { children: React.ReactNode; value?: string }) {
  return (
    <div className="apollo-label">
      <span>{children}</span>
      {value && <b key={value}>{value}</b>}
    </div>
  );
}

export function Group({ children }: { children: React.ReactNode }) {
  return <div className="apollo-group">{children}</div>;
}

export function Row(props: {
  icon: IconName;
  title: string;
  sub?: string;
  onClick?: () => void;
  right?: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <div
      className={'apollo-row' + (props.dim ? ' dim' : '') + (props.onClick ? ' tap' : '')}
      onClick={props.onClick}
      role={props.onClick ? 'button' : undefined}
      tabIndex={props.onClick ? 0 : undefined}
      onKeyDown={
        props.onClick
          ? (event) => event.key === 'Enter' && props.onClick?.()
          : undefined
      }
    >
      <span className="apollo-row-ico">
        <Icon n={props.icon} size={18} />
      </span>
      <span className="apollo-row-t">
        <b>{props.title}</b>
        {props.sub && <small>{props.sub}</small>}
      </span>
      {props.right ??
        (props.onClick && (
          <span className="apollo-row-chev">
            <Icon n="chev" size={18} />
          </span>
        ))}
    </div>
  );
}

export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className="apollo-toggle"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!on);
      }}
    >
      <i>
        <Icon n="check" size={14} />
      </i>
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="apollo-field">
      <label>{label}</label>
      <div className="apollo-field-box">{children}</div>
      {hint && <p className="apollo-hint">{hint}</p>}
    </div>
  );
}
