import { Component } from '@angular/core';

@Component({
  selector: 'app-footer',
  templateUrl: './footer.component.html',
  styleUrls: ['./footer.component.css'],
  standalone: false
})
export class FooterComponent {
  mail: string = 'simon.felix.conrad@proton.me';
  host: string = 'https://github.com/Meteor2333';
  github: string = 'https://github.com/Meteor2333/MinecraftModUpdater';
}
