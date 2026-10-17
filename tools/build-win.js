const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

function run(cmd, opts = {}) {
    console.log(`\n> ${cmd}`);
    execSync(cmd, { stdio: 'inherit', ...opts });
}

async function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            }
            response.pipe(file);
            file.on('finish', () => file.close(resolve));
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

async function prepareWinCodeSign() {
    if (process.platform !== 'win32') return;

    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return;

    const cacheDir = path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign');
    const targetDir = path.join(cacheDir, 'winCodeSign-2.6.0');

    if (fs.existsSync(path.join(targetDir, 'windows-10'))) {
        return;
    }

    fs.mkdirSync(cacheDir, { recursive: true });

    let archivePath = null;
    if (fs.existsSync(cacheDir)) {
        const files = fs.readdirSync(cacheDir);
        for (const f of files) {
            if (f.endsWith('.7z')) {
                archivePath = path.join(cacheDir, f);
                break;
            }
        }
    }

    const sevenZip = path.join(__dirname, '../node_modules/7zip-bin/win/x64/7za.exe');

    if (!archivePath || !fs.existsSync(archivePath)) {
        archivePath = path.join(cacheDir, 'winCodeSign-2.6.0.7z');
        if (!fs.existsSync(archivePath)) {
            console.log('Подготовка инструментов сборщика (winCodeSign)...');
            try {
                await downloadFile(
                    'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z',
                    archivePath
                );
            } catch (e) {
                console.warn('Предупреждение: автозагрузка winCodeSign не удалась, продолжаем обычную сборку:', e.message);
                return;
            }
        }
    }

    if (fs.existsSync(sevenZip) && fs.existsSync(archivePath)) {
        console.log('Распаковка инструментов сборщика без конфликтов с правами Windows...');
        fs.mkdirSync(targetDir, { recursive: true });
        spawnSync(sevenZip, ['x', '-bd', '-y', archivePath, `-o${targetDir}`, '-xr!darwin'], {
            stdio: 'ignore',
        });
    }
}

async function main() {
    console.log('========================================================');
    console.log('Сборка портативного приложения ObjToSchematic (.exe)');
    console.log('========================================================');

    // 1. Проверяем зависимости
    if (!fs.existsSync(path.join(__dirname, '../node_modules/.bin/webpack')) &&
        !fs.existsSync(path.join(__dirname, '../node_modules/.bin/webpack.cmd'))) {
        console.log('\n[1/3] Установка необходимых пакетов...');
        run('npm install --legacy-peer-deps --no-audit --no-fund --loglevel=error');
    } else {
        console.log('\n[1/3] Зависимости проверены (OK)');
    }

    // 2. Сборка веб-приложения через Webpack
    console.log('\n[2/3] Компиляция проекта (Webpack)...');
    run('npm run dist');

    // 3. Подготовка к упаковке
    console.log('\n[3/3] Упаковка в единый портативный EXE...');
    await prepareWinCodeSign();

    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    run('npx electron-builder --config electron-builder.json --win portable');

    const exePath = path.join(__dirname, '../dist-electron/ObjToSchematic-Portable.exe');
    console.log('\n========================================================');
    if (fs.existsSync(exePath)) {
        console.log('ГОТОВО! Исполняемый файл успешно создан:');
        console.log(exePath);
    } else {
        console.log('Сборка завершена. Проверьте папку dist-electron');
    }
    console.log('========================================================\n');
}

main().catch((err) => {
    console.error('\n[ОШИБКА СБОРКИ]:', err.message || err);
    process.exit(1);
});
