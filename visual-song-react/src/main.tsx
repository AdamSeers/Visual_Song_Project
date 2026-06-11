import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import Live from './pages/Live'
import Images from './pages/Images'
import Notes from './pages/Notes'
import Song from './pages/Song'
import About from './pages/About'
import Camera from './pages/Camera'
import VideoToSound from './pages/VideoToSound'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/live" element={<Live />} />
          <Route path="/images" element={<Images />} />
          <Route path="/notes" element={<Notes />} />
          <Route path="/song" element={<Song />} />
          <Route path="/about" element={<About />} />
          <Route path="/camera" element={<Camera />} />
          <Route path="/video" element={<VideoToSound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)