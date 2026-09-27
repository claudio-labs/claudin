import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetSidePanelStoreForTests,
  closeSidePanel,
  getSidePanelSnapshot,
  openSidePanel,
  type SidePanelComponent,
  subscribeSidePanel,
} from 'src/terminal/sidePanelStore.js'

// The store never calls the component, so a bare function stands in for one
// without dragging ink (unimportable under `bun test`) into the file.
const Panel = (() => null) as unknown as SidePanelComponent
const Other = (() => null) as unknown as SidePanelComponent

afterEach(() => {
  __resetSidePanelStoreForTests()
})

describe('sidePanelStore', () => {
  test('starts closed', () => {
    expect(getSidePanelSnapshot()).toBeNull()
  })

  test('open then close notifies subscribers', () => {
    let notifications = 0
    const unsubscribe = subscribeSidePanel(() => notifications++)

    openSidePanel(Panel)
    expect(getSidePanelSnapshot()?.Component).toBe(Panel)
    expect(notifications).toBe(1)

    closeSidePanel()
    expect(getSidePanelSnapshot()).toBeNull()
    expect(notifications).toBe(2)

    unsubscribe()
  })

  test('snapshot identity is stable between changes', () => {
    openSidePanel(Panel)
    expect(getSidePanelSnapshot()).toBe(getSidePanelSnapshot())
  })

  test('re-opening the same component is a no-op', () => {
    let notifications = 0
    subscribeSidePanel(() => notifications++)

    openSidePanel(Panel)
    const first = getSidePanelSnapshot()
    openSidePanel(Panel)

    expect(notifications).toBe(1)
    expect(getSidePanelSnapshot()).toBe(first)
  })

  test('opening a different component replaces the panel', () => {
    openSidePanel(Panel)
    openSidePanel(Other)
    expect(getSidePanelSnapshot()?.Component).toBe(Other)
  })

  test('closing twice notifies once', () => {
    openSidePanel(Panel)
    let notifications = 0
    subscribeSidePanel(() => notifications++)

    closeSidePanel()
    closeSidePanel()
    expect(notifications).toBe(1)
  })

  test('unsubscribed listeners stop receiving notifications', () => {
    let notifications = 0
    const unsubscribe = subscribeSidePanel(() => notifications++)
    unsubscribe()

    openSidePanel(Panel)
    expect(notifications).toBe(0)
  })

  // An inline session shows the panel through a fullscreen lease; every way
  // the panel closes has to hand it back, or the session stays in the alt
  // screen with nothing on it.
  describe('fullscreen lease', () => {
    const leaseCounter = () => {
      const counter = { held: 0, acquired: 0 }
      const acquire = () => {
        counter.held++
        counter.acquired++
        return () => {
          counter.held--
        }
      }
      return { counter, acquire }
    }

    test('is taken on open and released on close', () => {
      const { counter, acquire } = leaseCounter()
      openSidePanel(Panel, acquire)
      expect(counter.held).toBe(1)
      closeSidePanel()
      expect(counter.held).toBe(0)
    })

    test('a re-open that is a no-op takes no second lease', () => {
      const { counter, acquire } = leaseCounter()
      openSidePanel(Panel, acquire)
      openSidePanel(Panel, acquire)
      expect(counter.acquired).toBe(1)
    })

    test('replacing the panel hands the old lease back', () => {
      const { counter, acquire } = leaseCounter()
      openSidePanel(Panel, acquire)
      openSidePanel(Other, acquire)
      expect(counter.held).toBe(1)
      closeSidePanel()
      expect(counter.held).toBe(0)
    })

    test('the lease is released before subscribers hear the close', () => {
      const { counter, acquire } = leaseCounter()
      openSidePanel(Panel, acquire)
      let heldWhenNotified = -1
      subscribeSidePanel(() => {
        heldWhenNotified = counter.held
      })
      closeSidePanel()
      expect(heldWhenNotified).toBe(0)
    })
  })
})
