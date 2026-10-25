/**
 * src/index.tsx
 * React 渲染进程入口
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './styles/global.css';

// ==================== Ant Design 工作台主题配置 ====================

const studioTheme = {
  algorithm: theme.defaultAlgorithm,
  token: {
    // 品牌色 - 紫色系
    colorPrimary: '#6c5ce7',
    colorInfo: '#6c5ce7',
    colorSuccess: '#238563',
    colorWarning: '#b97515',
    colorError: '#ce4453',
    fontSize: 14,
    controlHeight: 34,
    // 基础色
    colorBgBase: '#f5f5f7',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorBorder: '#e2e3e8',
    colorTextBase: '#252631',
    colorTextSecondary: '#6b6d7c',
    // 圆角
    borderRadius: 8,
    // 字体
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  components: {
    Button: {
      colorPrimary: '#6c5ce7',
      algorithm: true,
    },
    Modal: {
      colorBgElevated: '#ffffff',
    },
    Dropdown: {
      colorBgElevated: '#ffffff',
    },
    Input: {
      colorBgContainer: '#ffffff',
    },
    Tag: {
      borderRadiusSM: 9999,
    },
  },
};

// ==================== 渲染 ====================

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider theme={studioTheme} locale={zhCN}>
      <App />
    </ConfigProvider>
  </React.StrictMode>
);
