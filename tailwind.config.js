/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx,html}'],
  // 深色主题为核心，Ant Design 5 使用 CSS-in-JS，互不冲突
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 豆包工作室品牌色系 - 深色创作者工具风格
        'db-bg': {
          DEFAULT: '#f5f5f7',
          secondary: '#ffffff',
          tertiary: '#ffffff',
        },
        'db-surface': {
          DEFAULT: '#ffffff',
          hover: '#e2e3e8',
          active: '#e9e9f0',
        },
        'db-border': {
          DEFAULT: '#e2e3e8',
          light: '#d6d7df',
        },
        'db-accent': {
          DEFAULT: '#6c5ce7', // 主紫色
          light: '#6855c9',
          dark: '#5a4bd1',
        },
        'db-text': {
          primary: '#252631',
          secondary: '#6b6d7c',
          muted: '#737584',
        },
        'db-status': {
          idle: '#4ade80',    // 空闲 - 绿色
          busy: '#b97515',    // 忙碌 - 琥珀色
          error: '#ce4453',   // 异常 - 红色
          queued: '#60a5fa',  // 排队中 - 蓝色
          done: '#238563',    // 已完成 - 翠绿
          fail: '#fb7185',    // 失败 - 玫红
        },
      },
      fontFamily: {
        sans: ['"Inter"', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
      fontSize: {
        '2xs': ['12px', { lineHeight: '18px' }],
      },
      borderRadius: {
        'db': '8px',
        'db-lg': '12px',
      },
      boxShadow: {
        'db': '0 2px 8px rgba(0, 0, 0, 0.4)',
        'db-lg': '0 8px 32px rgba(0, 0, 0, 0.6)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
  // 确保不与 Ant Design 样式冲突
  important: false,
};
