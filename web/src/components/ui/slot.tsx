import * as React from "react";

type AnyProps = Record<string, unknown> & {
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
};

function composeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") {
        ref(node);
      } else if (ref && typeof ref === "object") {
        (ref as React.MutableRefObject<T | null>).current = node;
      }
    }
  };
}

function getElementRef(element: React.ReactElement): React.Ref<unknown> | undefined {
  const props = element.props as AnyProps & { ref?: React.Ref<unknown> };
  return props.ref ?? (element as unknown as { ref?: React.Ref<unknown> }).ref;
}

function mergeProps(slotProps: AnyProps, childProps: AnyProps): AnyProps {
  const overrideProps: AnyProps = { ...childProps };
  for (const propName of Object.keys(childProps)) {
    const slotPropValue = slotProps[propName];
    const childPropValue = childProps[propName];
    if (/^on[A-Z]/.test(propName)) {
      if (typeof slotPropValue === "function" && typeof childPropValue === "function") {
        overrideProps[propName] = (...args: unknown[]) => {
          const result = (childPropValue as (...args: unknown[]) => unknown)(...args);
          (slotPropValue as (...args: unknown[]) => unknown)(...args);
          return result;
        };
      } else if (typeof slotPropValue === "function") {
        overrideProps[propName] = slotPropValue;
      }
    } else if (propName === "style") {
      overrideProps[propName] = { ...(slotPropValue as React.CSSProperties), ...(childPropValue as React.CSSProperties) };
    } else if (propName === "className") {
      overrideProps[propName] = [slotPropValue, childPropValue].filter(Boolean).join(" ");
    }
  }
  return { ...slotProps, ...overrideProps };
}

/**
 * Minimal Radix-compatible `Slot`: forwards props and refs to the single child
 * element. Kept local so the frontend build does not depend on a top-level
 * install of `@radix-ui/react-slot`, which can be nested away by npm install
 * strategies in constrained build environments.
 */
export const Slot = React.forwardRef<HTMLElement, AnyProps>((props, forwardedRef) => {
  const { children, ...slotProps } = props;
  if (!React.isValidElement(children)) {
    return React.Children.count(children) > 1 ? React.Children.only(null) : null;
  }

  const childRef = getElementRef(children);
  const mergedProps = mergeProps(slotProps, children.props as AnyProps);
  if (children.type !== React.Fragment) {
    mergedProps.ref = forwardedRef ? composeRefs(forwardedRef, childRef as React.Ref<HTMLElement>) : childRef;
  }
  return React.cloneElement(children, mergedProps as React.Attributes);
});

Slot.displayName = "Slot";
