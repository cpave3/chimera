import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { StatusBar } from '../src/StatusBar';

describe('StatusBar structural memo', () => {
  it('does not re-render widgets when the same JSX is recreated with a new reference', () => {
    let renderCount = 0;

    function CounterWidget(): React.ReactElement {
      renderCount += 1;
      return <Text>{renderCount}</Text>;
    }

    const { rerender, lastFrame } = render(<StatusBar left={[<CounterWidget key="cw" />]} />);
    const initialCount = renderCount;
    const firstFrame = lastFrame();

    // Re-create the same JSX tree with a new element reference
    rerender(<StatusBar left={[<CounterWidget key="cw" />]} />);

    expect(lastFrame()).toBe(firstFrame);
    // Widget should not have re-rendered because StatusBar memo bailed out
    expect(renderCount).toBe(initialCount);
  });

  it('does re-render when text content actually changes', () => {
    let renderCount = 0;

    function CounterWidget(): React.ReactElement {
      renderCount += 1;
      return <Text>{renderCount}</Text>;
    }

    const { rerender, lastFrame } = render(<StatusBar left={[<CounterWidget key="cw" />]} />);
    const initialCount = renderCount;
    const firstFrame = lastFrame();

    // Same props — should bail out
    rerender(<StatusBar left={[<CounterWidget key="cw" />]} />);
    expect(renderCount).toBe(initialCount);

    // Now change the child text
    rerender(
      <StatusBar
        left={[
          <Text key="changed" color="red">
            changed
          </Text>,
        ]}
      />,
    );
    expect(lastFrame()).not.toBe(firstFrame);
  });

  it('bails out for right widgets recreated with identical props', () => {
    let renderCount = 0;

    function FakeUsage(): React.ReactElement {
      renderCount += 1;
      return <Text>usage</Text>;
    }

    const { rerender, lastFrame } = render(
      <StatusBar left={[<Text key="left">left</Text>]} right={[<FakeUsage key="fu" />]} />,
    );
    const initialCount = renderCount;
    const firstFrame = lastFrame();

    // Recreate the same right widgets
    rerender(<StatusBar left={[<Text key="left">left</Text>]} right={[<FakeUsage key="fu" />]} />);

    expect(lastFrame()).toBe(firstFrame);
    expect(renderCount).toBe(initialCount);
  });
});
