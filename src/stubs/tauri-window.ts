export type CloseRequestedEvent = {
  preventDefault: () => void;
};

class MockWindow {
  async onCloseRequested(_handler: (event: CloseRequestedEvent) => void | Promise<void>): Promise<() => void> {
    return () => {};
  }

  async startDragging(): Promise<void> {
    return undefined;
  }

  async minimize(): Promise<void> {
    return undefined;
  }

  async toggleMaximize(): Promise<void> {
    return undefined;
  }

  async close(): Promise<void> {
    return undefined;
  }
}

const mockWindow = new MockWindow();

export function getCurrentWindow(): MockWindow {
  return mockWindow;
}

export function appWindow(): MockWindow {
  return mockWindow;
}
