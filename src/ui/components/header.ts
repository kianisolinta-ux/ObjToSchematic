import IMAGE_LOGO from '../../../res/static/icon.png';
import { AppConfig } from '../../config';
import { LOC } from '../../localiser';
import { UIUtil } from '../../util/ui_util';
import { BaseComponent } from './base';

export class HeaderComponent extends BaseComponent<HTMLDivElement> {
    private static _instance: HeaderComponent;
    public static get Get() {
        return this._instance || (this._instance = new this());
    }

    private constructor() {
        super();
    }

    // Header element shouldn't be
    protected override _onEnabledChanged(): void {
        return;
    }

    public override generateHTML(): string {
        return `
            <div class="col-container header-cols">
                <div class="col-container">
                    <div class="col-item">
                        <img class="logo" alt="Logo" src="${IMAGE_LOGO}">
                    </div>
                    <div class="col-item">
                        <div class="row-container">
                            <div class="row-item title">
                                ObjToSchematic
                            </div>
                            <div class="row-item subtitle">
                                ${AppConfig.Get.getVersionString()} • Minecraft ${AppConfig.Get.MINECRAFT_VERSION}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="row-container header-cols">
                <div class="row-container" style="padding-top: 5px;" id="header-desc">
                    ${LOC('description')}
                </div>
                <div class="row-container privacy-disclaimer" style="padding-top: 5px;">
                    This site may use cookies and similar tracking technologies (like web beacons) to access and store information about usage.
                </div>
            </div>
        `;
    }

    public refresh() {
        UIUtil.getElementById('header-desc').innerText = LOC('description');
    }

    public override registerEvents(): void {
    }

    public override finalise(): void {
    }
}
