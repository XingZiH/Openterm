import React from 'react'
import ReactDOM from 'react-dom/client'
import { FileContextMenuWindow } from './components/FileContextMenuWindow'
import './assets/file-context-menu.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FileContextMenuWindow />
  </React.StrictMode>
)
