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
    // 已批准的深青绿色品牌与浅色桌面主题
    colorPrimary: '#087F72',
    colorInfo: '#087F72',
    colorSuccess: '#238563',
    colorWarning: '#b97515',
    colorError: '#ce4453',
    fontSize: 14,
    controlHeight: 36,
    controlHeightSM: 30,
    // 基础色
    colorBgBase: '#F4F6F8',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorBorder: '#E3E8EB',
    colorTextBase: '#202A35',
    colorTextSecondary: '#697584',
    // 圆角
    borderRadius: 8,
    // 字体
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  components: {
    Button: {
      colorPrimary: '#087F72',
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
      borderRadiusSM: 5,
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
