---
name: Neo-Brutalist Campus Exchange
colors:
  surface: '#f9f9f9'
  surface-dim: '#dadada'
  surface-bright: '#f9f9f9'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f3f3'
  surface-container: '#eeeeee'
  surface-container-high: '#e8e8e8'
  surface-container-highest: '#e2e2e2'
  on-surface: '#1b1b1b'
  on-surface-variant: '#5d3f38'
  inverse-surface: '#303030'
  inverse-on-surface: '#f1f1f1'
  outline: '#926f66'
  outline-variant: '#e7bdb3'
  surface-tint: '#b42900'
  primary: '#af2800'
  on-primary: '#ffffff'
  primary-container: '#db3400'
  on-primary-container: '#fffbff'
  inverse-primary: '#ffb4a2'
  secondary: '#676000'
  on-secondary: '#ffffff'
  secondary-container: '#f3e300'
  on-secondary-container: '#6c6400'
  tertiary: '#00694b'
  on-tertiary: '#ffffff'
  tertiary-container: '#008560'
  on-tertiary-container: '#f5fff7'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffdad2'
  primary-fixed-dim: '#ffb4a2'
  on-primary-fixed: '#3c0700'
  on-primary-fixed-variant: '#891d00'
  secondary-fixed: '#f7e600'
  secondary-fixed-dim: '#d8ca00'
  on-secondary-fixed: '#1f1c00'
  on-secondary-fixed-variant: '#4e4800'
  tertiary-fixed: '#3effbf'
  tertiary-fixed-dim: '#00e1a5'
  on-tertiary-fixed: '#002115'
  on-tertiary-fixed-variant: '#005139'
  background: '#f9f9f9'
  on-background: '#1b1b1b'
  surface-variant: '#e2e2e2'
typography:
  headline-xl:
    fontFamily: Space Grotesk
    fontSize: 40px
    fontWeight: '700'
    lineHeight: 44px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Space Grotesk
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 36px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Space Grotesk
    fontSize: 28px
    fontWeight: '700'
    lineHeight: 32px
  headline-md:
    fontFamily: Space Grotesk
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 28px
  body-lg:
    fontFamily: Space Mono
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 26px
  body-md:
    fontFamily: Space Mono
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-bold:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '700'
    lineHeight: 16px
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 14px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  gutter: 16px
  margin-mobile: 20px
  border-width: 4px
---

## Brand & Style
The design system adopts a **Neo-Brutalist** aesthetic specifically tailored for a high-energy campus environment. The personality is unapologetic, functional, and urgent—essential for a lost-and-found utility. It rejects the "softness" of modern SaaS in favor of raw, high-contrast structural elements that command attention. 

The target audience consists of students and faculty who need to identify items instantly across various lighting conditions (e.g., walking between classes). The emotional response should be one of clarity and confidence; the UI doesn't hide behind shadows or gradients but presents information with absolute transparency and "digital-physical" weight.

## Colors
The palette is built on a "Warning & Action" logic. 
- **Primary (Vibrant Orange):** Reserved for critical actions like "Report Lost Item" or "I Found This."
- **Secondary (Bright Yellow):** Used for highlighting status tags (e.g., "Pending") and warnings.
- **Tertiary (Neon Mint Green):** Used for success states, "Recovered" statuses, and secondary navigation accents.
- **Neutral/Background:** Pure white background for maximum contrast against 4px black borders. All text and structural outlines use pure black (#000000) to maintain the brutalist integrity. No grays are permitted.

## Typography
The typography strategy utilizes a mix of technical geometric sans and strict monospaced fonts to reinforce the "industrial" campus feel.
- **Headlines:** Space Grotesk provides a bold, blocky impact for screen titles and item names.
- **Body:** Space Mono ensures that item descriptions and metadata (like timestamps and locations) look like data entries, emphasizing the utility of the app.
- **Labels:** JetBrains Mono is used for tags, button text, and small UI indicators to maintain a high-contrast, technical look even at small scales. All labels should lean toward uppercase to match the brutalist energy.

## Layout & Spacing
This design system uses a strict **8-pixel grid** for spacing, but all structural elements are governed by the **4px border-width**. 

The layout is a **fixed-fluid hybrid**: 
- On mobile, use a 2-column or 1-column grid with a 20px outer margin.
- Gutters are strictly 16px to allow the 4px borders of adjacent cards to have breathing room without feeling cluttered.
- Elements should be "stacked" vertically with consistent 16px or 24px gaps. 
- Avoid "centered" content; use left-aligned layouts to mimic technical documents and directories.

## Elevation & Depth
Depth in this system is strictly 2D-synthetic. There are no Z-axis blurs or soft shadows.
- **Hard Shadows:** All interactive elements (cards, buttons) must feature a **6px 6px 0px #000000** offset shadow. 
- **Active State:** When an element is pressed, the shadow disappears (`0px 0px 0px`), and the element shifts 4px down and 4px right to simulate a physical "click" into the page.
- **Layering:** Use flat color fills (Yellow or Mint) to denote a "raised" layer versus the white background.

## Shapes
The shape language is strictly **Sharp (0px)**. Every container, button, input field, and image frame must have 90-degree corners. This reinforces the Brutalist "raw construction" philosophy and ensures the 4px black borders join perfectly at every vertex. 
- Do not use rounded corners for chips or tags; use rectangular boxes with thick outlines instead.
- Icons should be stroke-based, using 2px or 4px lines to match the UI's visual weight.

## Components
- **Buttons:** Large, rectangular blocks with a 4px black border and a hard 6px shadow. Primary buttons use #FF3E00 with white or black text.
- **Cards:** White background, 4px black border, hard shadow. Header sections within cards should be separated by a 4px horizontal black line.
- **Input Fields:** Pure white background, 4px black border. On focus, the background changes to #FFEE00 (Yellow) to highlight the active entry area.
- **Chips/Tags:** Small rectangles with a 2px black border. Use #00F5B4 (Mint) for status tags like "Found" and #FFEE00 (Yellow) for "Lost."
- **Lists:** Items are separated by 4px black dividers. Each list item should feel like a distinct "row" in a ledger.
- **Photo Placeholders:** When an item image is missing, use a high-contrast "X" pattern across a #FFFFFF box with a 4px border.