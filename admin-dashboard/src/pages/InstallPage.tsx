import { useState } from 'react';
import { Download, Copy, Check, Monitor, Wifi } from 'lucide-react';

const API_URL = 'https://endpointx.onrender.com';

export default function InstallPage() {
  const [copied, setCopied] = useState('');

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  const installScript = `irm ${API_URL}/api/devices/public/install.ps1 | iex`;

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6 flex items-center gap-2">
        <Monitor className="w-6 h-6" />
        Instalar Agent em Novos PCs
      </h1>

      <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4 mb-6">
        <p className="text-blue-400 text-sm">
          Use este guia para conectar outros PCs da rede ao sistema EndpointX.
        </p>
      </div>

      {/* Method 1: One-line install */}
      <div className="bg-gray-800 rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Download className="w-5 h-5 text-green-400" />
          Metodo 1: Instalacao Rapida (Recomendado)
        </h2>
        <p className="text-gray-400 text-sm mb-4">
          No PC remoto, abra o PowerShell como Administrador e cole este comando:
        </p>
        <div className="bg-gray-900 rounded p-3 flex items-center justify-between">
          <code className="text-green-400 text-xs break-all">{installScript}</code>
          <button
            onClick={() => copyToClipboard(installScript, 'quick')}
            className="ml-3 p-2 hover:bg-gray-700 rounded flex-shrink-0"
          >
            {copied === 'quick' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>
        <p className="text-gray-500 text-xs mt-2">
          Requer Python instalado com "Add to PATH" marcado.
        </p>
      </div>

      {/* Method 2: Git install */}
      <div className="bg-gray-800 rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Wifi className="w-5 h-5 text-blue-400" />
          Metodo 2: Via Git
        </h2>
        <p className="text-gray-400 text-sm mb-4">
          No PC remoto, instale o Python e Git, depois execute:
        </p>
        <div className="space-y-3">
          <div>
            <p className="text-gray-500 text-xs mb-1">1. Instalar Git (se nao tiver)</p>
            <div className="bg-gray-900 rounded p-3 flex items-center justify-between">
              <code className="text-yellow-400 text-xs">https://git-scm.com/download/win</code>
              <button
                onClick={() => copyToClipboard('https://git-scm.com/download/win', 'git')}
                className="ml-3 p-2 hover:bg-gray-700 rounded"
              >
                {copied === 'git' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-1">2. Clonar e instalar</p>
            <div className="bg-gray-900 rounded p-3 flex items-center justify-between">
              <code className="text-green-400 text-xs">
                git clone https://github.com/Masukulmiguel/endpointx.git{'\n'}
                cd endpointx/endpoint-agent{'\n'}
                pip install -r requirements.txt{'\n'}
                python agent.py --register{'\n'}
                python agent.py
              </code>
              <button
                onClick={() => copyToClipboard(
                  'git clone https://github.com/Masukulmiguel/endpointx.git; cd endpointx/endpoint-agent; pip install -r requirements.txt; python agent.py --register; python agent.py',
                  'git-install'
                )}
                className="ml-3 p-2 hover:bg-gray-700 rounded"
              >
                {copied === 'git-install' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Config info */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">Configuracao Automatica</h2>
        <p className="text-gray-400 text-sm mb-4">
          Os agents serao automaticamente configurados para apontar para:
        </p>
        <div className="bg-gray-900 rounded p-3">
          <code className="text-purple-400 text-xs">{API_URL}/api</code>
        </div>
        <p className="text-gray-500 text-xs mt-2">
          Nao e necessario editar o config.yaml manualmente.
        </p>
      </div>
    </div>
  );
}
